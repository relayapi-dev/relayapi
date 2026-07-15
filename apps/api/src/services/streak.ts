/**
 * Posting streak service — tracks org-level posting streaks.
 *
 * - updateStreak(): called after a successful post publish (upsert)
 * - checkStreaks(): called by cron to expire stale streaks and send warnings
 */

import type { Database } from "@relayapi/db";
import { createDb, orgStreaks, publishOutbox } from "@relayapi/db";
import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";
import {
	dispatchPublishOutbox,
	notificationOutboxRow,
} from "./publish-outbox";
import {
	enqueuePersistedWebhookEvent,
	type PersistedWebhookEvent,
	persistWebhookEventInTransaction,
	type WebhookTransaction,
} from "./webhook-delivery";

const STREAK_WINDOW_HOURS = 24;
const WARNING_HOURS = 22;

const MILESTONE_DAYS = [7, 30, 100, 365];
const STREAK_CRON_BATCH_SIZE = 100;

export interface PersistedStreakUpdate {
	streak: typeof orgStreaks.$inferSelect;
	persistedEvents: PersistedWebhookEvent[];
	milestoneReached: boolean;
	occurredAtIso: string;
}

/**
 * Persist the streak transition and its webhook outbox rows in a caller-owned
 * transaction. Post terminalization uses this so a crash cannot commit a
 * successful post while losing its streak effect, and it avoids a second
 * transaction round-trip on the publish hot path.
 */
export async function persistStreakUpdateInTransaction(
	tx: WebhookTransaction,
	orgId: string,
	occurredAt: Date = new Date(),
): Promise<PersistedStreakUpdate | null> {
	const occurredAtIso = occurredAt.toISOString();
	// A delayed recovery must not resurrect an occurrence whose 24-hour window
	// has already elapsed. Normal publish completion uses the current timestamp.
	if (
		Date.now() - occurredAt.getTime() >=
		STREAK_WINDOW_HOURS * 60 * 60 * 1000
	) {
		return null;
	}

	const [streak] = await tx
		.insert(orgStreaks)
		.values({
			organizationId: orgId,
			streakStartedAt: occurredAt,
			lastPostAt: occurredAt,
			currentStreakDays: 1,
		})
		.onConflictDoUpdate({
			target: orgStreaks.organizationId,
			// The event time is the durable watermark. Strictly older/equal replays
			// return no row, so concurrent completions cannot move lastPostAt backward
			// or clear a warning raised for a newer state.
			setWhere: sql`${orgStreaks.lastPostAt} IS NULL OR ${orgStreaks.lastPostAt} < ${occurredAtIso}::timestamptz`,
			set: {
				lastPostAt: occurredAt,
				currentStreakDays: sql`
					CASE
						WHEN ${orgStreaks.streakStartedAt} IS NULL THEN 1
						ELSE GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${occurredAtIso}::timestamptz - ${orgStreaks.streakStartedAt})) / 86400)::int + 1)
					END
				`,
				streakStartedAt: sql`COALESCE(${orgStreaks.streakStartedAt}, ${occurredAtIso}::timestamptz)`,
				warningEmailSentAt: null,
				updatedAt: occurredAt,
			},
		})
		.returning();
	if (!streak) return null;

	const persistedEvents: PersistedWebhookEvent[] = [];
	const streakStartedIso =
		streak.streakStartedAt?.toISOString() ?? occurredAtIso;
	const wasInactive = streakStartedIso === occurredAtIso;
	if (wasInactive) {
		persistedEvents.push(
			await persistWebhookEventInTransaction(
				tx,
				orgId,
				"streak.started",
				{
					current_streak_days: 1,
					streak_started_at: streakStartedIso,
				},
				{
					occurrenceId: `streak:${streak.id}:started:${streakStartedIso}`,
				},
			),
		);
	}

	let milestoneReached = false;
	if (MILESTONE_DAYS.includes(streak.currentStreakDays)) {
		// The outbox's unique operation ID doubles as a tiny durable occurrence
		// ledger. Only its first insert scans webhook endpoints and emits realtime;
		// later posts on the same milestone day do no duplicate work. The marker is
		// born dispatched, so it is never sent to the Queue.
		const [marker] = await tx
			.insert(publishOutbox)
			.values({
				operationId: `streak-milestone:${streak.id}:${streak.currentStreakDays}`,
				organizationId: orgId,
				kind: "post_completion",
				payload: {
					type: "streak_milestone_marker",
					streak_id: streak.id,
					current_streak_days: streak.currentStreakDays,
				},
				status: "dispatched",
				dispatchedAt: occurredAt,
			})
			.onConflictDoNothing()
			.returning({ id: publishOutbox.id });
		milestoneReached = !!marker;
	}
	if (milestoneReached) {
		persistedEvents.push(
			await persistWebhookEventInTransaction(
				tx,
				orgId,
				"streak.milestone",
				{
					current_streak_days: streak.currentStreakDays,
					streak_started_at: streakStartedIso,
				},
				{
					occurrenceId: `streak:${streak.id}:milestone:${streak.currentStreakDays}`,
				},
			),
		);
	}
	return { streak, persistedEvents, milestoneReached, occurredAtIso };
}

/** Dispatch best-effort realtime work after the durable streak rows commit. */
export async function dispatchPersistedStreakUpdate(
	env: Env,
	db: Database,
	orgId: string,
	outcome: PersistedStreakUpdate,
): Promise<void> {
	const { streak, persistedEvents, milestoneReached, occurredAtIso } = outcome;
	const followUps: Promise<unknown>[] = persistedEvents.map((persisted) =>
		enqueuePersistedWebhookEvent(env, db, persisted),
	);
	if (milestoneReached) {
		followUps.push(
			notifyRealtime(env, orgId, {
				type: "streak.milestone",
				current_streak_days: streak.currentStreakDays,
			}),
		);
	}
	// Always push a realtime update so the dashboard can refresh the badge.
	followUps.push(
		notifyRealtime(env, orgId, {
			type: "streak.updated",
			current_streak_days: streak.currentStreakDays,
			last_post_at: occurredAtIso,
		}),
	);

	const results = await Promise.allSettled(followUps);
	const failures = results.filter(
		(result) => result.status === "rejected",
	).length;
	if (failures > 0) {
		// Webhook rows are durable and the pending dispatcher will retry their
		// queue handoff. Realtime delivery is intentionally best-effort.
		console.error(`[streak] ${failures} post-commit follow-up(s) failed`);
	}
}

/**
 * Upsert the org streak after a successful post publish.
 * Creates the row on first post, extends lastPostAt on subsequent posts.
 * streakStartedAt is only set when starting a new streak (COALESCE preserves existing).
 */
export async function updateStreak(
	env: Env,
	db: Database,
	orgId: string,
	occurredAt: Date = new Date(),
): Promise<void> {
	const outcome = await db.transaction((tx) =>
		persistStreakUpdateInTransaction(tx, orgId, occurredAt),
	);
	if (!outcome) return;
	await dispatchPersistedStreakUpdate(env, db, orgId, outcome);
}

/**
 * Cron job: check all active streaks for expiry and warnings.
 * Should run frequently (every 5 minutes) for timely warnings.
 */
export async function checkStreaks(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const warningThreshold = new Date(
		now.getTime() - WARNING_HOURS * 60 * 60 * 1000,
	);
	const expiryThreshold = new Date(
		now.getTime() - STREAK_WINDOW_HOURS * 60 * 60 * 1000,
	);

	// 1. Find streaks that need warning (22h+ since last post, not yet warned, not yet expired)
	const needsWarning = await db
		.select()
		.from(orgStreaks)
		.where(
			and(
				isNotNull(orgStreaks.streakStartedAt),
				lt(orgStreaks.lastPostAt, warningThreshold),
				gte(orgStreaks.lastPostAt, expiryThreshold),
				isNull(orgStreaks.warningEmailSentAt),
			),
		)
		.orderBy(asc(orgStreaks.lastPostAt), asc(orgStreaks.id))
		.limit(STREAK_CRON_BATCH_SIZE);

	for (const streak of needsWarning) {
		const hoursRemaining = streak.lastPostAt
			? Math.max(
					0,
					STREAK_WINDOW_HOURS -
						(Date.now() - streak.lastPostAt.getTime()) / (1000 * 60 * 60),
				)
			: 0;
		const occurrenceId = `streak:${streak.id}:warning:${streak.lastPostAt?.toISOString() ?? "unknown"}`;
		const persisted = await db.transaction(async (tx) => {
			const [claimed] = await tx
				.update(orgStreaks)
				.set({ warningEmailSentAt: now, updatedAt: now })
				.where(
					and(
						eq(orgStreaks.id, streak.id),
						isNull(orgStreaks.warningEmailSentAt),
						...(streak.lastPostAt
							? [eq(orgStreaks.lastPostAt, streak.lastPostAt)]
							: [isNull(orgStreaks.lastPostAt)]),
					),
				)
				.returning({ id: orgStreaks.id });
			if (!claimed) return null;
			const webhook = await persistWebhookEventInTransaction(
				tx,
				streak.organizationId,
				"streak.warning",
				{
					current_streak_days: streak.currentStreakDays,
					streak_started_at: streak.streakStartedAt?.toISOString() ?? null,
					last_post_at: streak.lastPostAt?.toISOString() ?? null,
				},
				{ occurrenceId },
			);
			await tx
				.insert(publishOutbox)
				.values(
					notificationOutboxRow({
						organizationId: streak.organizationId,
						type: "streak_warning",
						title: "Your posting streak is about to end!",
						body: `You have ${Math.round(hoursRemaining * 10) / 10} hours to post and keep your ${streak.currentStreakDays}-day streak alive.`,
						data: {
							currentStreakDays: streak.currentStreakDays,
							hoursRemaining: Math.round(hoursRemaining * 10) / 10,
						},
						occurrenceId,
					}),
				)
				.onConflictDoNothing();
			return webhook;
		});
		if (!persisted) continue;
		await enqueuePersistedWebhookEvent(env, db, persisted);
	}

	// 2. Find and expire streaks that are past the 24h window
	const expired = await db
		.select()
		.from(orgStreaks)
		.where(
			and(
				isNotNull(orgStreaks.streakStartedAt),
				lt(orgStreaks.lastPostAt, expiryThreshold),
			),
		)
		.orderBy(asc(orgStreaks.lastPostAt), asc(orgStreaks.id))
		.limit(STREAK_CRON_BATCH_SIZE);

	for (const streak of expired) {
		if (!streak.streakStartedAt) continue;
		const streakStartedAt = streak.streakStartedAt;
		const brokenDays = streak.currentStreakDays;
		const occurrenceId = `streak:${streak.id}:broken:${streakStartedAt.toISOString()}`;
		const persisted = await db.transaction(async (tx) => {
			const [transitioned] = await tx
				.update(orgStreaks)
				.set({
					bestStreakDays: sql`GREATEST(${orgStreaks.bestStreakDays}, ${orgStreaks.currentStreakDays})`,
					totalStreaksBroken: sql`${orgStreaks.totalStreaksBroken} + 1`,
					streakStartedAt: null,
					lastPostAt: null,
					currentStreakDays: 0,
					warningEmailSentAt: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(orgStreaks.id, streak.id),
						eq(orgStreaks.streakStartedAt, streakStartedAt),
						...(streak.lastPostAt
							? [eq(orgStreaks.lastPostAt, streak.lastPostAt)]
							: [isNull(orgStreaks.lastPostAt)]),
					),
				)
				.returning({ id: orgStreaks.id });
			if (!transitioned) return null;
			const webhook = await persistWebhookEventInTransaction(
				tx,
				streak.organizationId,
				"streak.broken",
				{
					broken_streak_days: brokenDays,
					best_streak_days: Math.max(streak.bestStreakDays, brokenDays),
				},
				{ occurrenceId },
			);
			await tx
				.insert(publishOutbox)
				.values(
					notificationOutboxRow({
						organizationId: streak.organizationId,
						type: "streak_warning",
						title: "Your posting streak ended",
						body: `Your ${brokenDays}-day posting streak has ended. Start a new one by publishing a post!`,
						data: {
							brokenStreakDays: brokenDays,
							bestStreakDays: Math.max(streak.bestStreakDays, brokenDays),
						},
						occurrenceId,
					}),
				)
				.onConflictDoNothing();
			return webhook;
		});
		if (!persisted) continue;
		await enqueuePersistedWebhookEvent(env, db, persisted);

		const realtimeNotification = notifyRealtime(env, streak.organizationId, {
			type: "streak.broken",
			broken_streak_days: brokenDays,
		});

		const followUpResults = await Promise.allSettled([realtimeNotification]);
		const followUpFailures = followUpResults.filter(
			(result) => result.status === "rejected",
		).length;
		if (followUpFailures > 0) {
			console.error(
				`[streak] ${followUpFailures} broken-streak follow-up(s) failed`,
			);
		}
	}

	if (needsWarning.length > 0 || expired.length > 0) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error("[streak] Durable notification dispatch deferred", error);
		}
		console.log(
			`[streak] Checked streaks: ${needsWarning.length} warned, ${expired.length} expired`,
		);
	}
}
