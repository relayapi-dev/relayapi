import { createDb, posts, postTargets } from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { incrementUsage } from "../middleware/usage-tracking";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";

/**
 * Process all scheduled posts whose scheduled_at <= now.
 * Called from the cron trigger in index.ts.
 *
 * Thread-aware: non-root thread items (threadPosition > 0) are skipped here —
 * they are driven by the thread publisher's chain mechanism. Root thread items
 * (threadPosition === 0) are enqueued as publish_thread messages.
 */
export async function processScheduledPosts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const duePosts = await db
		.select({
			id: posts.id,
			organizationId: posts.organizationId,
			threadGroupId: posts.threadGroupId,
			threadPosition: posts.threadPosition,
		})
		.from(posts)
		.where(
			and(
				eq(posts.status, "scheduled"),
				lte(posts.scheduledAt, new Date()),
				// Skip non-root thread items — they are driven by publishThreadPosition
				or(isNull(posts.threadGroupId), eq(posts.threadPosition, 0)),
			),
		)
		.orderBy(asc(posts.scheduledAt))
		.limit(50);

	if (duePosts.length === 0) return;

	// Batch-fetch all targets for due posts in one query
	const duePostIds = duePosts.map((p) => p.id);
	const allTargets = await db
		.select({ id: postTargets.id, postId: postTargets.postId })
		.from(postTargets)
		.where(inArray(postTargets.postId, duePostIds));

	// Count targets per post
	const targetCountByPost = new Map<string, number>();
	for (const t of allTargets) {
		targetCountByPost.set(t.postId, (targetCountByPost.get(t.postId) ?? 0) + 1);
	}

	// Group usage units by orgId so we increment once per org
	const usageByOrg = new Map<string, number>();
	for (const post of duePosts) {
		const units = Math.max(targetCountByPost.get(post.id) ?? 0, 1);
		usageByOrg.set(
			post.organizationId,
			(usageByOrg.get(post.organizationId) ?? 0) + units,
		);
	}

	// Increment usage once per org
	await Promise.allSettled(
		[...usageByOrg.entries()].map(([orgId, units]) =>
			incrementUsage(env.KV, orgId, units),
		),
	);

	// Enqueue to PUBLISH_QUEUE — thread root posts use publish_thread, standalone posts use publish
	await Promise.allSettled(
		duePosts.map((post) => {
			if (post.threadGroupId && post.threadPosition === 0) {
				// Thread root: enqueue thread publish which handles the full chain
				return env.PUBLISH_QUEUE.send({
					type: "publish_thread",
					thread_group_id: post.threadGroupId,
					org_id: post.organizationId,
					position: 0,
				});
			}
			// Standalone post
			return env.PUBLISH_QUEUE.send({
				type: "publish",
				post_id: post.id,
				org_id: post.organizationId,
				usage_tracked: true,
			});
		}),
	);

	// Notify dashboard that scheduled posts are now being published.
	// Group by org to send one notification per org (not per post).
	const orgsWithDuePosts = [...new Set(duePosts.map((p) => p.organizationId))];
	await Promise.allSettled(
		orgsWithDuePosts.map((orgId) => {
			const orgPosts = duePosts.filter((p) => p.organizationId === orgId);
			return notifyRealtime(env, orgId, {
				type: "post.updated",
				post_id: orgPosts[0]!.id,
				status: "publishing",
			});
		}),
	);
}
