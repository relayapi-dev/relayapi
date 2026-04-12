import {
	createDb,
	postRecyclingConfigs,
	posts,
	postTargets,
} from "@relayapi/db";
import { and, asc, eq, lte } from "drizzle-orm";
import { incrementUsage } from "../middleware/usage-tracking";
import type { Env } from "../types";
import { computeNextRecycleAt } from "./recycling-validator";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { notifyRealtime } from "../lib/notify-post-update";

/**
 * Process all recycling configs whose next_recycle_at <= now.
 * Called from the cron trigger in index.ts every minute.
 */
export async function processRecyclingPosts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const dueConfigs = await db
		.select()
		.from(postRecyclingConfigs)
		.where(
			and(
				eq(postRecyclingConfigs.enabled, true),
				lte(postRecyclingConfigs.nextRecycleAt, new Date()),
			),
		)
		.orderBy(asc(postRecyclingConfigs.nextRecycleAt))
		.limit(20);

	if (dueConfigs.length === 0) return;

	for (const config of dueConfigs) {
		try {
			await processOneConfig(env, db, config);
		} catch (err) {
			console.error(
				`[recycling] Error processing config ${config.id}:`,
				err,
			);
		}
	}
}

async function processOneConfig(
	env: Env,
	db: ReturnType<typeof createDb>,
	config: typeof postRecyclingConfigs.$inferSelect,
): Promise<void> {
	// Atomic claim: update nextRecycleAt to future value WHERE it matches current.
	// If another worker already processed this, rowCount === 0.
	const futureNextRecycle = computeNextRecycleAt(
		new Date(),
		config.gap,
		config.gapFreq,
	);

	const claimed = await db
		.update(postRecyclingConfigs)
		.set({ nextRecycleAt: futureNextRecycle })
		.where(
			and(
				eq(postRecyclingConfigs.id, config.id),
				eq(postRecyclingConfigs.nextRecycleAt, config.nextRecycleAt!),
			),
		)
		.returning({ id: postRecyclingConfigs.id });

	if (claimed.length === 0) return;

	// Check expiration by count
	if (
		config.expireCount !== null &&
		config.recycleCount >= config.expireCount
	) {
		await db
			.update(postRecyclingConfigs)
			.set({ enabled: false, updatedAt: new Date() })
			.where(eq(postRecyclingConfigs.id, config.id));
		return;
	}

	// Check expiration by date
	if (config.expireDate !== null && new Date() > config.expireDate) {
		await db
			.update(postRecyclingConfigs)
			.set({ enabled: false, updatedAt: new Date() })
			.where(eq(postRecyclingConfigs.id, config.id));
		return;
	}

	// Load source post
	const [sourcePost] = await db
		.select()
		.from(posts)
		.where(eq(posts.id, config.sourcePostId))
		.limit(1);

	if (!sourcePost) {
		// Source post was deleted (FK cascade should have removed config, but be safe)
		await db
			.update(postRecyclingConfigs)
			.set({ enabled: false, updatedAt: new Date() })
			.where(eq(postRecyclingConfigs.id, config.id));
		return;
	}

	// Load source targets
	const sourceTargets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, config.sourcePostId));

	// Determine content variation
	const variations = config.contentVariations;
	const content =
		variations && variations.length > 0
			? variations[config.contentVariationIndex % variations.length]
			: sourcePost.content;

	// Create new post
	const rows = await db
		.insert(posts)
		.values({
			organizationId: config.organizationId,
			workspaceId: sourcePost.workspaceId,
			content,
			status: "scheduled",
			scheduledAt: new Date(),
			timezone: sourcePost.timezone,
			platformOverrides: sourcePost.platformOverrides,
			recycledFromId: config.sourcePostId,
			createdBy: sourcePost.createdBy,
		})
		.returning();
	const newPost = rows[0];
	if (!newPost) return;

	// Copy post_targets (exclude youtube/tiktok as safety net)
	const targetValues = sourceTargets
		.filter((t) => t.platform !== "youtube" && t.platform !== "tiktok")
		.map((t) => ({
			postId: newPost.id,
			socialAccountId: t.socialAccountId,
			platform: t.platform,
			status: "scheduled" as const,
		}));

	if (targetValues.length > 0) {
		await db.insert(postTargets).values(targetValues);
	}

	// Increment usage
	await incrementUsage(
		env.KV,
		config.organizationId,
		Math.max(targetValues.length, 1),
	);

	// Enqueue to publish queue
	await env.PUBLISH_QUEUE.send({
		type: "publish",
		post_id: newPost.id,
		org_id: config.organizationId,
		usage_tracked: true,
	});

	// Push real-time update — posts page already listens for post.* events
	await notifyRealtime(env, config.organizationId, { type: "post.created", post_id: newPost.id, status: "scheduled" }).catch(() => {});

	// Update config state
	const nextVariationIndex =
		variations && variations.length > 0
			? (config.contentVariationIndex + 1) % variations.length
			: 0;
	const newRecycleCount = config.recycleCount + 1;

	await db
		.update(postRecyclingConfigs)
		.set({
			recycleCount: newRecycleCount,
			contentVariationIndex: nextVariationIndex,
			lastRecycledAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(postRecyclingConfigs.id, config.id));

	// Disable if count limit reached after increment
	if (
		config.expireCount !== null &&
		newRecycleCount >= config.expireCount
	) {
		await db
			.update(postRecyclingConfigs)
			.set({ enabled: false, updatedAt: new Date() })
			.where(eq(postRecyclingConfigs.id, config.id));
	}

	// Dispatch webhook
	await dispatchWebhookEvent(
		env,
		db,
		config.organizationId,
		"post.recycled",
		{
			source_post_id: config.sourcePostId,
			recycled_post_id: newPost.id,
			recycle_count: newRecycleCount,
			content_variation_used: config.contentVariationIndex,
			next_recycle_at:
				config.expireCount !== null &&
				newRecycleCount >= config.expireCount
					? null
					: futureNextRecycle.toISOString(),
			remaining_cycles:
				config.expireCount !== null
					? config.expireCount - newRecycleCount
					: null,
		},
		sourcePost.workspaceId,
	);
}
