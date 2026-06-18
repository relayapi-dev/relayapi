import {
	createDb,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getPublisher } from "../publishers";
import { maybeDecrypt } from "../lib/crypto";
import { dispatchWebhookEvent } from "./webhook-delivery";
import type { Env } from "../types";
import type { Platform } from "../schemas/common";
import type { PublishResult, MediaAttachment } from "../publishers/types";

/**
 * Platforms that support threading via reply chains.
 */
const THREADABLE_PLATFORMS = new Set<string>([
	"twitter",
	"threads",
	"bluesky",
	"mastodon",
	"linkedin",
	"facebook",
	"telegram",
	"discord",
]);

export function isThreadable(platform: string): boolean {
	return THREADABLE_PLATFORMS.has(platform);
}

/**
 * Publish all thread items for a given position (and subsequent zero-delay items).
 * Returns the next position that needs a delayed publish, or null if done.
 */
export async function publishThreadPosition(
	env: Env,
	threadGroupId: string,
	orgId: string,
	startPosition: number,
): Promise<{ nextPosition: number | null; nextDelayMs: number; positionFailed?: boolean }> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Fetch all thread posts ordered by position
	const threadPosts = await db
		.select({
			id: posts.id,
			content: posts.content,
			threadPosition: posts.threadPosition,
			threadDelayMs: posts.threadDelayMs,
			platformOverrides: posts.platformOverrides,
			status: posts.status,
			updatedAt: posts.updatedAt,
			organizationId: posts.organizationId,
			workspaceId: posts.workspaceId,
		})
		.from(posts)
		.where(
			and(
				eq(posts.threadGroupId, threadGroupId),
				eq(posts.organizationId, orgId),
			),
		)
		.orderBy(asc(posts.threadPosition));

	if (threadPosts.length === 0) return { nextPosition: null, nextDelayMs: 0 };

	// Fetch all targets for all thread posts
	const postIds = threadPosts.map((p) => p.id);
	const targets = await db
		.select({
			id: postTargets.id,
			postId: postTargets.postId,
			socialAccountId: postTargets.socialAccountId,
			platform: postTargets.platform,
			status: postTargets.status,
			platformPostId: postTargets.platformPostId,
		})
		.from(postTargets)
		.where(inArray(postTargets.postId, postIds));

	// Group targets by post ID
	const targetsByPost = new Map<string, typeof targets>();
	for (const t of targets) {
		const list = targetsByPost.get(t.postId) ?? [];
		list.push(t);
		targetsByPost.set(t.postId, list);
	}

	// Get unique account IDs and fetch account details
	const accountIds = [...new Set(targets.map((t) => t.socialAccountId))];
	if (accountIds.length === 0) {
		// No targets exist — nothing to publish
		return { nextPosition: null, nextDelayMs: 0 };
	}
	const accountRows = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			metadata: socialAccounts.metadata,
		})
		.from(socialAccounts)
		.where(inArray(socialAccounts.id, accountIds));

	const accountMap = new Map(accountRows.map((a) => [a.id, a]));

	// Determine which positions to publish in this invocation
	// Start at startPosition, continue until we hit a position with delay > 0
	const positionsToPublish: number[] = [];

	for (const post of threadPosts) {
		if ((post.threadPosition ?? 0) < startPosition) continue;
		if ((post.threadPosition ?? 0) === startPosition) {
			positionsToPublish.push(post.threadPosition ?? 0);
			continue;
		}
		// For subsequent positions, only include if delay is 0
		if ((post.threadDelayMs ?? 0) === 0) {
			positionsToPublish.push(post.threadPosition ?? 0);
		} else {
			// This position has a delay - stop here
			break;
		}
	}

	// For native-thread platforms (twitter, threads, bluesky), try publishing all items at once
	// For others, publish one at a time with reply chains
	const postsToPublish = threadPosts.filter(
		(p) => positionsToPublish.includes(p.threadPosition ?? 0),
	);

	// Collect previous positions' platform post IDs for reply chaining.
	// The platformPostId is already loaded in the targets query above, so read it
	// from memory instead of issuing one SELECT per previous-position target (N+1).
	const previousPlatformPostIds = new Map<string, string>(); // accountId -> platformPostId
	if (startPosition > 0) {
		const prevPost = threadPosts.find((p) => (p.threadPosition ?? 0) === startPosition - 1);
		if (prevPost) {
			const prevTargets = targetsByPost.get(prevPost.id) ?? [];
			for (const pt of prevTargets) {
				if (pt.platformPostId) {
					previousPlatformPostIds.set(pt.socialAccountId, pt.platformPostId);
				}
			}
		}
	}

	// Publish each item for each account
	for (const post of postsToPublish) {
		const postTargetList = targetsByPost.get(post.id) ?? [];
		const overrides = (post.platformOverrides ?? {}) as Record<string, unknown>;
		const mediaItems = (overrides._media as MediaAttachment[]) ?? [];

		// Atomically claim this thread item before any platform calls. Cloudflare Queues
		// are at-least-once and handleThreadPublish retries the whole position on any
		// escaped error, so without a claim a redelivery/retry re-publishes already-live
		// items (duplicate tweets/posts). Compare-and-swap on (status, updatedAt): the CAS
		// only succeeds when the post is still "scheduled"/"publishing" AND its updatedAt
		// matches what we read, so two concurrent deliveries cannot both claim the same
		// item. If another worker advanced it (terminal status, or bumped updatedAt), skip
		// its platform calls entirely.
		const claimed = await db
			.update(posts)
			.set({ status: "publishing", updatedAt: new Date() })
			.where(
				and(
					eq(posts.id, post.id),
					inArray(posts.status, ["scheduled", "publishing"]),
					eq(posts.updatedAt, post.updatedAt),
				),
			)
			.returning({ id: posts.id });
		if (claimed.length === 0) {
			// Already finalized by another delivery. Still surface its published targets'
			// platformPostId into the reply chain so subsequent positions can chain.
			for (const t of postTargetList) {
				if (t.status === "published" && t.platformPostId) {
					previousPlatformPostIds.set(t.socialAccountId, t.platformPostId);
				}
			}
			continue;
		}

		let successCount = 0;
		let failCount = 0;

		for (const target of postTargetList) {
			// Idempotency: a target already marked "published" was published on a prior
			// (possibly retried/redelivered) run. Do not re-publish it — that would create
			// a duplicate post on the platform. Reuse its stored platformPostId for the
			// reply chain and count it as a success.
			if (target.status === "published") {
				if (target.platformPostId) {
					previousPlatformPostIds.set(target.socialAccountId, target.platformPostId);
				}
				successCount++;
				continue;
			}

			const account = accountMap.get(target.socialAccountId);
			if (!account) {
				await db
					.update(postTargets)
					.set({ status: "failed", error: "Account not found", updatedAt: new Date() })
					.where(eq(postTargets.id, target.id));
				failCount++;
				continue;
			}

			// Skip non-threadable platforms for non-root items
			if ((post.threadPosition ?? 0) > 0 && !isThreadable(target.platform)) {
				await db
					.update(postTargets)
					.set({ status: "failed", error: "Platform does not support threading", updatedAt: new Date() })
					.where(eq(postTargets.id, target.id));
				continue;
			}

			try {
				const publisher = getPublisher(target.platform as Platform);
				if (!publisher) {
					await db
						.update(postTargets)
						.set({ status: "failed", error: `No publisher for ${target.platform}`, updatedAt: new Date() })
						.where(eq(postTargets.id, target.id));
					failCount++;
					continue;
				}

				const accessToken = await maybeDecrypt(account.accessToken, env.ENCRYPTION_KEY) ?? "";
				const refreshToken = account.refreshToken
					? await maybeDecrypt(account.refreshToken, env.ENCRYPTION_KEY)
					: null;

				// Build target_options with reply_to for non-root items
				const targetOpts: Record<string, unknown> = {
					...(overrides[target.platform] as Record<string, unknown> ?? {}),
				};

				if ((post.threadPosition ?? 0) > 0) {
					const prevPostId = previousPlatformPostIds.get(target.socialAccountId);
					if (prevPostId) {
						targetOpts.reply_to = prevPostId;
					}
				}

				// Publish
				const result: PublishResult = await publisher.publish({
					content: post.content ?? "",
					media: mediaItems,
					target_options: targetOpts,
					account: {
						id: account.id,
						platform: account.platform,
						access_token: accessToken,
						refresh_token: refreshToken,
						platform_account_id: account.platformAccountId,
						username: account.username,
						metadata: account.metadata as Record<string, unknown> | null,
					},
				});

				if (result.success) {
					await db
						.update(postTargets)
						.set({
							status: "published",
							platformPostId: result.platform_post_id ?? null,
							platformUrl: result.platform_url ?? null,
							publishedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(postTargets.id, target.id));

					// Store this post's platform ID for the next item's reply chain
					if (result.platform_post_id) {
						previousPlatformPostIds.set(target.socialAccountId, result.platform_post_id);
					}
					successCount++;
				} else {
					await db
						.update(postTargets)
						.set({
							status: "failed",
							error: result.error?.message ?? "Unknown error",
							updatedAt: new Date(),
						})
						.where(eq(postTargets.id, target.id));
					failCount++;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "Unknown error";
				await db
					.update(postTargets)
					.set({ status: "failed", error: message, updatedAt: new Date() })
					.where(eq(postTargets.id, target.id));
				failCount++;
			}
		}

		// Update post status — exclude skipped targets from the success/fail calculation.
		// When every target was skipped (non-threadable platforms on a non-root item),
		// the item published nothing, so it must NOT be marked "published" (that would
		// contradict its own target rows, all "failed", and set a bogus publishedAt that
		// makes thread.published fire). The post_status enum has no "skipped" value, so
		// mark it "failed" (accurate: nothing went live) and leave publishedAt unset.
		// failCount is 0 here, so the chain-abort guard below does not trigger.
		const attemptedCount = successCount + failCount;
		const finalStatus = attemptedCount === 0
			? "failed" // all targets were skipped (non-threadable) — nothing published
			: successCount === attemptedCount
				? "published"
				: successCount === 0
					? "failed"
					: "partial";
		await db
			.update(posts)
			.set({
				status: finalStatus,
				publishedAt: finalStatus === "published" ? new Date() : undefined,
				updatedAt: new Date(),
			})
			.where(eq(posts.id, post.id));

		// Abort the chain only on real publish failures (not pure skips).
		// If all targets were skipped or some succeeded, continue the chain.
		if (successCount === 0 && failCount > 0) {
			return { nextPosition: null, nextDelayMs: 0, positionFailed: true };
		}
	}

	// Determine next position that needs publishing
	const lastPublished = positionsToPublish[positionsToPublish.length - 1] ?? startPosition;
	const nextPost = threadPosts.find(
		(p) => (p.threadPosition ?? 0) > lastPublished,
	);

	if (!nextPost) {
		// Thread is complete. Only dispatch thread.published if at least one target
		// across the whole thread actually went live — otherwise a thread whose items
		// were all skipped/failed would emit a success event. Re-read the persisted
		// target statuses (the in-memory `targets` snapshot predates this run's writes).
		const finalTargets = await db
			.select({ status: postTargets.status })
			.from(postTargets)
			.where(inArray(postTargets.postId, postIds));
		const hasRealSuccess = finalTargets.some((t) => t.status === "published");

		const rootPost = threadPosts[0];
		if (rootPost && hasRealSuccess) {
			void dispatchWebhookEvent(
				env,
				db,
				orgId,
				"thread.published",
				{
					thread_group_id: threadGroupId,
					item_count: threadPosts.length,
				},
				rootPost.workspaceId ?? undefined,
			);
		}
		return { nextPosition: null, nextDelayMs: 0 };
	}

	return {
		nextPosition: nextPost.threadPosition ?? 0,
		nextDelayMs: nextPost.threadDelayMs ?? 0,
	};
}
