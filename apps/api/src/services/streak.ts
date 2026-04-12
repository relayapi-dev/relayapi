/**
 * Posting streak service — tracks org-level posting streaks.
 *
 * - updateStreak(): called after a successful post publish (upsert)
 * - checkStreaks(): called by cron to expire stale streaks and send warnings
 */

import {
	createDb,
	orgStreaks,
	member,
	notificationPreferences,
} from "@relayapi/db";
import type { Database } from "@relayapi/db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { sendNotification } from "./notification-manager";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";

const STREAK_WINDOW_HOURS = 24;
const WARNING_HOURS = 22;

const MILESTONE_DAYS = [7, 30, 100, 365];

/**
 * Upsert the org streak after a successful post publish.
 * Creates the row on first post, extends lastPostAt on subsequent posts.
 * streakStartedAt is only set when starting a new streak (COALESCE preserves existing).
 */
export async function updateStreak(
	env: Env,
	db: Database,
	orgId: string,
): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();

	// Read the existing row before upserting so we can detect new-streak starts
	const [existing] = await db
		.select({ streakStartedAt: orgStreaks.streakStartedAt })
		.from(orgStreaks)
		.where(eq(orgStreaks.organizationId, orgId))
		.limit(1);

	const wasInactive = !existing || existing.streakStartedAt === null;

	const result = await db
		.insert(orgStreaks)
		.values({
			organizationId: orgId,
			streakStartedAt: now,
			lastPostAt: now,
			currentStreakDays: 1,
		})
		.onConflictDoUpdate({
			target: orgStreaks.organizationId,
			set: {
				lastPostAt: now,
				currentStreakDays: sql`
					CASE
						WHEN ${orgStreaks.streakStartedAt} IS NULL THEN 1
						ELSE GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${nowIso}::timestamptz - ${orgStreaks.streakStartedAt})) / 86400)::int + 1)
					END
				`,
				streakStartedAt: sql`COALESCE(${orgStreaks.streakStartedAt}, ${nowIso}::timestamptz)`,
				warningEmailSentAt: null,
				updatedAt: now,
			},
		})
		.returning();

	const streak = result[0];
	if (!streak) return;

	// If this started a new streak (row was missing or had null streakStartedAt)
	if (wasInactive) {
		dispatchWebhookEvent(env, db, orgId, "streak.started", {
			current_streak_days: 1,
			streak_started_at: nowIso,
		}).catch((err) =>
			console.error("[streak] Failed to dispatch streak.started webhook:", err),
		);
	}

	// Check for milestones
	if (MILESTONE_DAYS.includes(streak.currentStreakDays)) {
		dispatchWebhookEvent(env, db, orgId, "streak.milestone", {
			current_streak_days: streak.currentStreakDays,
			streak_started_at: streak.streakStartedAt?.toISOString() ?? null,
		}).catch((err) =>
			console.error("[streak] Failed to dispatch streak.milestone webhook:", err),
		);

		notifyRealtime(env, orgId, {
			type: "streak.milestone",
			current_streak_days: streak.currentStreakDays,
		}).catch((err) =>
			console.error("[streak] Failed to send milestone realtime event:", err),
		);
	}

	// Always push a realtime update so the dashboard can refresh the badge
	notifyRealtime(env, orgId, {
		type: "streak.updated",
		current_streak_days: streak.currentStreakDays,
		last_post_at: nowIso,
	}).catch((err) =>
		console.error("[streak] Failed to send streak realtime event:", err),
	);
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
		);

	for (const streak of needsWarning) {
		// Send warning notifications to org members
		await sendStreakWarnings(env, db, streak).catch((err) =>
			console.error(
				`[streak] Failed to send warnings for org ${streak.organizationId}:`,
				err,
			),
		);

		await db
			.update(orgStreaks)
			.set({ warningEmailSentAt: now, updatedAt: now })
			.where(eq(orgStreaks.id, streak.id));

		dispatchWebhookEvent(
			env,
			db,
			streak.organizationId,
			"streak.warning",
			{
				current_streak_days: streak.currentStreakDays,
				streak_started_at: streak.streakStartedAt?.toISOString() ?? null,
				last_post_at: streak.lastPostAt?.toISOString() ?? null,
			},
		).catch((err) =>
			console.error("[streak] Failed to dispatch streak.warning webhook:", err),
		);
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
		);

	for (const streak of expired) {
		const brokenDays = streak.currentStreakDays;

		await db
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
			.where(eq(orgStreaks.id, streak.id));

		dispatchWebhookEvent(
			env,
			db,
			streak.organizationId,
			"streak.broken",
			{
				broken_streak_days: brokenDays,
				best_streak_days: Math.max(
					streak.bestStreakDays,
					brokenDays,
				),
			},
		).catch((err) =>
			console.error("[streak] Failed to dispatch streak.broken webhook:", err),
		);

		notifyRealtime(env, streak.organizationId, {
			type: "streak.broken",
			broken_streak_days: brokenDays,
		}).catch((err) =>
			console.error("[streak] Failed to send streak.broken realtime event:", err),
		);

		// Send broken streak notifications to org members
		await sendStreakBrokenNotifications(env, db, streak, brokenDays).catch(
			(err) =>
				console.error(
					`[streak] Failed to send broken notifications for org ${streak.organizationId}:`,
					err,
				),
		);
	}

	if (needsWarning.length > 0 || expired.length > 0) {
		console.log(
			`[streak] Checked streaks: ${needsWarning.length} warned, ${expired.length} expired`,
		);
	}
}

/**
 * Send streak warning notifications to all members of an org who have streak warnings enabled.
 */
async function sendStreakWarnings(
	env: Env,
	db: Database,
	streak: typeof orgStreaks.$inferSelect,
): Promise<void> {
	const members = await getOrgMembersWithStreakPrefs(db, streak.organizationId);

	const hoursRemaining = streak.lastPostAt
		? Math.max(
				0,
				STREAK_WINDOW_HOURS -
					(Date.now() - streak.lastPostAt.getTime()) / (1000 * 60 * 60),
			)
		: 0;

	for (const m of members) {
		sendNotification(env, {
			type: "streak_warning",
			userId: m.userId,
			orgId: streak.organizationId,
			title: "Your posting streak is about to end!",
			body: `You have ${Math.round(hoursRemaining * 10) / 10} hours to post and keep your ${streak.currentStreakDays}-day streak alive.`,
			data: {
				currentStreakDays: streak.currentStreakDays,
				hoursRemaining: Math.round(hoursRemaining * 10) / 10,
			},
		}).catch((err) =>
			console.error(
				`[streak] Failed to send warning notification to user ${m.userId}:`,
				err,
			),
		);
	}
}

/**
 * Send streak broken notifications to all members of an org.
 */
async function sendStreakBrokenNotifications(
	env: Env,
	db: Database,
	streak: typeof orgStreaks.$inferSelect,
	brokenDays: number,
): Promise<void> {
	const members = await getOrgMembersWithStreakPrefs(db, streak.organizationId);

	for (const m of members) {
		sendNotification(env, {
			type: "streak_warning",
			userId: m.userId,
			orgId: streak.organizationId,
			title: "Your posting streak ended",
			body: `Your ${brokenDays}-day posting streak has ended. Start a new one by publishing a post!`,
			data: {
				brokenStreakDays: brokenDays,
				bestStreakDays: Math.max(streak.bestStreakDays, brokenDays),
			},
		}).catch((err) =>
			console.error(
				`[streak] Failed to send broken notification to user ${m.userId}:`,
				err,
			),
		);
	}
}

/**
 * Get org members who haven't opted out of streak notifications.
 */
async function getOrgMembersWithStreakPrefs(
	db: Database,
	orgId: string,
): Promise<Array<{ userId: string }>> {
	const rows = await db
		.select({ userId: member.userId })
		.from(member)
		.where(eq(member.organizationId, orgId));

	if (rows.length === 0) return [];

	const userIds = rows.map((r) => r.userId);
	const prefs = await db
		.select()
		.from(notificationPreferences)
		.where(inArray(notificationPreferences.userId, userIds));

	const prefsMap = new Map(prefs.map((p) => [p.userId, p]));

	return rows.filter((r) => {
		const pref = prefsMap.get(r.userId);
		if (!pref) return true; // No prefs row = use defaults (which include streak warnings)
		const streakPref = pref.streakWarnings as { push?: boolean; email?: boolean } | null;
		// Include if either push or email is enabled
		return streakPref?.push !== false || streakPref?.email !== false;
	});
}
