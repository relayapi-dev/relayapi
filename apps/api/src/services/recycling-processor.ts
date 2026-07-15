import {
	createDb,
	postRecyclingConfigs,
	posts,
	postTargets,
	publishOutbox,
	recyclingOccurrences,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";
import { computeNextRecycleAt } from "./recycling-validator";
import {
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

const RECYCLE_LEASE_MS = 5 * 60 * 1000;
const MAX_RECYCLE_ATTEMPTS = 5;

type ClaimedConfig = typeof postRecyclingConfigs.$inferSelect;

export function recyclingOperationId(
	configId: string,
	scheduledFor: Date,
): string {
	return `recycle:${configId}:${scheduledFor.toISOString()}`;
}

export async function processRecyclingPosts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select()
		.from(postRecyclingConfigs)
		.where(
			and(
				eq(postRecyclingConfigs.enabled, true),
				lte(postRecyclingConfigs.nextRecycleAt, now),
				or(
					inArray(postRecyclingConfigs.processingState, [
						"pending",
						"transient_failure",
					]),
					and(
						eq(postRecyclingConfigs.processingState, "processing"),
						lte(postRecyclingConfigs.leaseExpiresAt, now),
					),
				),
				or(
					isNull(postRecyclingConfigs.retryAt),
					lte(postRecyclingConfigs.retryAt, now),
				),
				or(
					isNull(postRecyclingConfigs.leaseExpiresAt),
					lte(postRecyclingConfigs.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(postRecyclingConfigs.nextRecycleAt))
		.limit(20);

	const claimed: ClaimedConfig[] = [];
	for (const candidate of candidates) {
		const [row] = await db
			.update(postRecyclingConfigs)
			.set({
				processingState: "processing",
				attempts: sql`${postRecyclingConfigs.attempts} + 1`,
				leaseToken: sql`${postRecyclingConfigs.leaseToken} + 1`,
				leaseExpiresAt: new Date(now.getTime() + RECYCLE_LEASE_MS),
				lastError: null,
			})
			.where(
				and(
					eq(postRecyclingConfigs.id, candidate.id),
					eq(postRecyclingConfigs.enabled, true),
					eq(postRecyclingConfigs.leaseToken, candidate.leaseToken),
					lte(postRecyclingConfigs.nextRecycleAt, now),
					or(
						inArray(postRecyclingConfigs.processingState, [
							"pending",
							"transient_failure",
						]),
						and(
							eq(postRecyclingConfigs.processingState, "processing"),
							lte(postRecyclingConfigs.leaseExpiresAt, now),
						),
					),
					or(
						isNull(postRecyclingConfigs.retryAt),
						lte(postRecyclingConfigs.retryAt, now),
					),
					or(
						isNull(postRecyclingConfigs.leaseExpiresAt),
						lte(postRecyclingConfigs.leaseExpiresAt, now),
					),
				),
			)
			.returning();
		if (row) claimed.push(row);
	}

	for (const config of claimed) {
		try {
			await processOneConfig(env, db, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const terminal = config.attempts >= MAX_RECYCLE_ATTEMPTS;
			const backoffMs = Math.min(30 * 60_000, 30_000 * 2 ** config.attempts);
			await db
				.update(postRecyclingConfigs)
				.set({
					processingState: terminal ? "terminal_failure" : "transient_failure",
					enabled: !terminal,
					leaseExpiresAt: null,
					retryAt: terminal ? null : new Date(Date.now() + backoffMs),
					lastError: message,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(postRecyclingConfigs.id, config.id),
						eq(postRecyclingConfigs.leaseToken, config.leaseToken),
					),
				);
			console.error(
				JSON.stringify({
					message: "recycling occurrence failed",
					configId: config.id,
					state: terminal ? "terminal_failure" : "transient_failure",
					error: message,
				}),
			);
		}
	}
	if (claimed.length > 0) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error("[recycling] Durable publish dispatch deferred", error);
		}
	}
}

async function processOneConfig(
	env: Env,
	db: ReturnType<typeof createDb>,
	config: ClaimedConfig,
): Promise<void> {
	const scheduledFor = config.nextRecycleAt;
	if (!scheduledFor) return;
	const operationId = recyclingOperationId(config.id, scheduledFor);
	const now = new Date();

	const result = await db.transaction(async (tx) => {
		const [fenced] = await tx
			.update(postRecyclingConfigs)
			.set({ leaseExpiresAt: new Date(now.getTime() + RECYCLE_LEASE_MS) })
			.where(
				and(
					eq(postRecyclingConfigs.id, config.id),
					eq(postRecyclingConfigs.leaseToken, config.leaseToken),
					eq(postRecyclingConfigs.processingState, "processing"),
				),
			)
			.returning({ id: postRecyclingConfigs.id });
		if (!fenced) throw new Error("Recycling lease lost");

		const [occurrence] = await tx
			.insert(recyclingOccurrences)
			.values({
				operationId,
				configId: config.id,
				organizationId: config.organizationId,
				scheduledFor,
				status: "processing",
			})
			.onConflictDoNothing()
			.returning({ id: recyclingOccurrences.id });
		if (!occurrence) {
			await tx
				.update(postRecyclingConfigs)
				.set({ processingState: "pending", leaseExpiresAt: null })
				.where(
					and(
						eq(postRecyclingConfigs.id, config.id),
						eq(postRecyclingConfigs.leaseToken, config.leaseToken),
					),
				);
			return null;
		}

		const expiredByCount =
			config.expireCount !== null && config.recycleCount >= config.expireCount;
		const expiredByDate = config.expireDate !== null && now > config.expireDate;
		if (expiredByCount || expiredByDate) {
			await tx
				.update(recyclingOccurrences)
				.set({
					status: "terminal_failure",
					error: "Recycling configuration expired",
					completedAt: now,
				})
				.where(eq(recyclingOccurrences.id, occurrence.id));
			await tx
				.update(postRecyclingConfigs)
				.set({
					enabled: false,
					processingState: "terminal_failure",
					leaseExpiresAt: null,
					lastError: "Recycling configuration expired",
					updatedAt: now,
				})
				.where(eq(postRecyclingConfigs.id, config.id));
			return null;
		}

		const [sourcePost] = await tx
			.select()
			.from(posts)
			.where(
				and(
					eq(posts.id, config.sourcePostId),
					eq(posts.organizationId, config.organizationId),
				),
			)
			.limit(1);
		if (!sourcePost) throw new Error("Recycling source post not found");

		const sourceTargets = await tx
			.select()
			.from(postTargets)
			.where(eq(postTargets.postId, config.sourcePostId));
		const eligibleTargets = sourceTargets.filter(
			(target) => target.platform !== "youtube" && target.platform !== "tiktok",
		);
		if (eligibleTargets.length === 0) {
			const error = "No eligible recycle targets remain";
			await tx
				.update(recyclingOccurrences)
				.set({ status: "terminal_failure", error, completedAt: now })
				.where(eq(recyclingOccurrences.id, occurrence.id));
			await tx
				.update(postRecyclingConfigs)
				.set({
					enabled: false,
					processingState: "terminal_failure",
					leaseExpiresAt: null,
					lastError: error,
					updatedAt: now,
				})
				.where(eq(postRecyclingConfigs.id, config.id));
			return null;
		}

		const variations = config.contentVariations ?? [];
		const content =
			variations.length > 0
				? variations[config.contentVariationIndex % variations.length]
				: sourcePost.content;
		const [newPost] = await tx
			.insert(posts)
			.values({
				organizationId: config.organizationId,
				workspaceId: sourcePost.workspaceId,
				content,
				status: "scheduled",
				scheduledAt: now,
				timezone: sourcePost.timezone,
				platformOverrides: sourcePost.platformOverrides,
				recycledFromId: config.sourcePostId,
				createdBy: sourcePost.createdBy,
			})
			.returning();
		if (!newPost) throw new Error("Failed to create recycled post");

		await tx.insert(postTargets).values(
			eligibleTargets.map((target) => ({
				organizationId: config.organizationId,
				postId: newPost.id,
				socialAccountId: target.socialAccountId,
				platform: target.platform,
				status: "scheduled" as const,
			})),
		);
		await tx.insert(publishOutbox).values(
			publishOutboxRow({
				organizationId: config.organizationId,
				postId: newPost.id,
				operationId,
			}),
		);

		const recycleCount = config.recycleCount + 1;
		const reachedCount =
			config.expireCount !== null && recycleCount >= config.expireCount;
		const nextRecycleAt = reachedCount
			? null
			: computeNextRecycleAt(now, config.gap, config.gapFreq);
		const nextVariationIndex =
			variations.length > 0
				? (config.contentVariationIndex + 1) % variations.length
				: 0;
		await tx
			.update(postRecyclingConfigs)
			.set({
				enabled: !reachedCount,
				processingState: reachedCount ? "terminal_failure" : "pending",
				attempts: 0,
				leaseExpiresAt: null,
				retryAt: null,
				lastError: null,
				recycleCount,
				contentVariationIndex: nextVariationIndex,
				lastRecycledAt: now,
				nextRecycleAt,
				updatedAt: now,
			})
			.where(
				and(
					eq(postRecyclingConfigs.id, config.id),
					eq(postRecyclingConfigs.leaseToken, config.leaseToken),
				),
			);
		await tx
			.update(recyclingOccurrences)
			.set({ status: "committed", postId: newPost.id, completedAt: now })
			.where(eq(recyclingOccurrences.id, occurrence.id));
		const webhook = await persistWebhookEventInTransaction(
			tx,
			config.organizationId,
			"post.recycled",
			{
				source_post_id: config.sourcePostId,
				recycled_post_id: newPost.id,
				recycle_count: recycleCount,
				content_variation_used: config.contentVariationIndex,
				next_recycle_at: nextRecycleAt?.toISOString() ?? null,
				remaining_cycles:
					config.expireCount !== null
						? config.expireCount - recycleCount
						: null,
				operation_id: operationId,
			},
			{
				workspaceId: newPost.workspaceId,
				occurrenceId: `recycling:${operationId}:committed`,
			},
		);
		return {
			post: newPost,
			recycleCount,
			nextRecycleAt,
			remainingCycles:
				config.expireCount !== null ? config.expireCount - recycleCount : null,
			webhook,
		};
	});

	if (!result) return;
	await Promise.all([
		enqueuePersistedWebhookEvent(env, db, result.webhook),
		notifyRealtime(env, config.organizationId, {
			type: "post.created",
			post_id: result.post.id,
			status: "scheduled",
		}),
	]);
}
