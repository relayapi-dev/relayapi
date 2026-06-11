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

	const duePostIds = duePosts.map((p) => p.id);

	// Atomically claim ALL due posts (standalone AND thread roots) by flipping them to
	// "publishing" BEFORE charging usage or enqueuing. Without this, when queue
	// consumption lags beyond one cron interval the same posts are re-selected every
	// minute — each tick re-charging KV usage and re-enqueuing duplicate publish messages
	// (full thread double-posting for roots). Both consumers tolerate a "publishing" post:
	// publishPostById CAS-claims on (status, updatedAt), and publishThreadPosition claims
	// each item with status in {scheduled, publishing}. The cron only ever re-selects
	// status="scheduled", so a claimed post is not re-enqueued next tick.
	const claimed = await db
		.update(posts)
		.set({ status: "publishing", updatedAt: new Date() })
		.where(and(inArray(posts.id, duePostIds), eq(posts.status, "scheduled")))
		.returning({ id: posts.id });
	const claimedIds = new Set(claimed.map((row) => row.id));

	// Only proceed with posts we actually claimed. A post that lost the claim race
	// (already flipped by a prior tick) is dropped so usage is not re-charged.
	const claimedPosts = duePosts.filter((p) => claimedIds.has(p.id));
	if (claimedPosts.length === 0) return;

	// Batch-fetch all targets for claimed posts in one query
	const claimedPostIds = claimedPosts.map((p) => p.id);
	const allTargets = await db
		.select({ id: postTargets.id, postId: postTargets.postId })
		.from(postTargets)
		.where(inArray(postTargets.postId, claimedPostIds));

	// Count targets per post
	const targetCountByPost = new Map<string, number>();
	for (const t of allTargets) {
		targetCountByPost.set(t.postId, (targetCountByPost.get(t.postId) ?? 0) + 1);
	}

	// Group usage units by orgId so we increment once per org
	const usageByOrg = new Map<string, number>();
	for (const post of claimedPosts) {
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

	// Build publish messages — thread root posts use publish_thread, standalone posts
	// use publish. Send via sendBatch (up to 100 messages per call) instead of one
	// send() per post to cut Queues subrequests at burst scheduling slots.
	const messages = claimedPosts.map((post) =>
		post.threadGroupId && post.threadPosition === 0
			? {
					body: {
						type: "publish_thread" as const,
						thread_group_id: post.threadGroupId,
						org_id: post.organizationId,
						position: 0,
					},
				}
			: {
					body: {
						type: "publish" as const,
						post_id: post.id,
						org_id: post.organizationId,
						usage_tracked: true,
					},
				},
	);
	const sendChunks: Array<typeof messages> = [];
	for (let i = 0; i < messages.length; i += 100) {
		sendChunks.push(messages.slice(i, i + 100));
	}
	await Promise.allSettled(
		sendChunks.map((chunk) => env.PUBLISH_QUEUE.sendBatch(chunk)),
	);

	// Notify dashboard that scheduled posts are now being published.
	// Group by org to send one notification per org (not per post).
	const orgsWithDuePosts = [...new Set(claimedPosts.map((p) => p.organizationId))];
	await Promise.allSettled(
		orgsWithDuePosts.map((orgId) => {
			const orgPosts = claimedPosts.filter((p) => p.organizationId === orgId);
			return notifyRealtime(env, orgId, {
				type: "post.updated",
				post_id: orgPosts[0]!.id,
				status: "publishing",
			});
		}),
	);
}
