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
 * Platforms that support native thread publishing (array of items in one call).
 * For these, we pass the full thread as target_options.thread.
 */
const NATIVE_THREAD_PLATFORMS = new Set<string>([
	"twitter",
	"threads",
	"bluesky",
]);

interface ThreadPost {
	id: string;
	content: string | null;
	threadPosition: number | null;
	threadDelayMs: number | null;
	platformOverrides: Record<string, unknown> | null;
	status: string;
}

interface ThreadTarget {
	id: string;
	postId: string;
	socialAccountId: string;
	platform: string;
	status: string;
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

	for (let i = 0; i < threadPosts.length; i++) {
		const post = threadPosts[i]!;
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

	// Collect previous positions' platform post IDs for reply chaining
	const previousPlatformPostIds = new Map<string, string>(); // accountId -> platformPostId
	if (startPosition > 0) {
		const prevPost = threadPosts.find((p) => (p.threadPosition ?? 0) === startPosition - 1);
		if (prevPost) {
			const prevTargets = targetsByPost.get(prevPost.id) ?? [];
			for (const pt of prevTargets) {
				// Fetch the platformPostId for this target
				const [targetRow] = await db
					.select({ platformPostId: postTargets.platformPostId })
					.from(postTargets)
					.where(eq(postTargets.id, pt.id))
					.limit(1);
				if (targetRow?.platformPostId) {
					previousPlatformPostIds.set(pt.socialAccountId, targetRow.platformPostId);
				}
			}
		}
	}

	// Publish each item for each account
	for (const post of postsToPublish) {
		const postTargetList = targetsByPost.get(post.id) ?? [];
		const overrides = (post.platformOverrides ?? {}) as Record<string, unknown>;
		const mediaItems = (overrides._media as MediaAttachment[]) ?? [];

		// Update post status to publishing
		await db
			.update(posts)
			.set({ status: "publishing", updatedAt: new Date() })
			.where(eq(posts.id, post.id));

		let successCount = 0;
		let failCount = 0;
		let skipCount = 0;

		for (const target of postTargetList) {
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
				skipCount++;
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

		// Update post status — exclude skipped targets from the success/fail calculation
		const attemptedCount = successCount + failCount;
		const finalStatus = attemptedCount === 0
			? "published" // all targets were skipped (non-threadable) — not a failure
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
		// Thread is complete - dispatch webhook
		const rootPost = threadPosts[0];
		if (rootPost) {
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
