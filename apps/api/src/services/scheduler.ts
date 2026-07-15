import { createDb, posts, postTargets, publishOutbox } from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";

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
	const claimed = await db.transaction(async (tx) => {
		const rows = await tx
			.update(posts)
			.set({
				status: "publishing",
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(and(inArray(posts.id, duePostIds), eq(posts.status, "scheduled")))
			.returning({ id: posts.id });
		const claimedIds = new Set(rows.map((row) => row.id));
		const claimedPosts = duePosts.filter((post) => claimedIds.has(post.id));
		if (claimedPosts.length > 0) {
			await tx
				.update(postTargets)
				.set({
					status: "publishing",
					deliveryState: "queued",
					updatedAt: new Date(),
				})
				.where(
					inArray(
						postTargets.postId,
						claimedPosts.map((post) => post.id),
					),
				);
			await tx
				.insert(publishOutbox)
				.values(
					claimedPosts.map((post) =>
						post.threadGroupId && post.threadPosition === 0
							? publishOutboxRow({
									organizationId: post.organizationId,
									threadGroupId: post.threadGroupId,
								})
							: publishOutboxRow({
									organizationId: post.organizationId,
									postId: post.id,
								}),
					),
				)
				.onConflictDoNothing();
		}
		return rows;
	});
	const claimedIds = new Set(claimed.map((row) => row.id));

	// Only proceed with posts we actually claimed. A post that lost the claim race
	// (already flipped by a prior tick) is dropped so usage is not re-charged.
	const claimedPosts = duePosts.filter((p) => claimedIds.has(p.id));
	if (claimedPosts.length === 0) return;

	await dispatchPublishOutbox(env);

	// Notify dashboard that scheduled posts are now being published.
	// Group by org to send one notification per org (not per post).
	const orgsWithDuePosts = [
		...new Set(claimedPosts.map((p) => p.organizationId)),
	];
	await Promise.allSettled(
		orgsWithDuePosts.map((orgId) => {
			const orgPosts = claimedPosts.filter((p) => p.organizationId === orgId);
			const firstPost = orgPosts[0];
			if (!firstPost) return Promise.resolve();
			return notifyRealtime(env, orgId, {
				type: "post.updated",
				post_id: firstPost.id,
				status: "publishing",
			});
		}),
	);
}
