// ---------------------------------------------------------------------------
// External Post Sync — Core Consumer Logic
// ---------------------------------------------------------------------------

import {
	createDb,
	externalPosts,
	socialAccounts,
	socialAccountSyncState,
	postTargets,
	eq,
} from "@relayapi/db";
import { and, inArray, sql } from "drizzle-orm";
import type { Env } from "../../types";
import type { SyncPostsMessage, RefreshMetricsMessage } from "./types";
import { RateLimitError } from "./types";
import { getExternalPostFetcher } from "./index";
import { refreshTokenIfNeeded } from "../token-refresh";
import { mapConcurrently } from "../../lib/concurrency";

type Database = ReturnType<typeof createDb>;

const MAX_PAGES_PER_RUN = 5;

// ---------------------------------------------------------------------------
// Main sync: fetch posts from a platform and upsert into external_posts
// ---------------------------------------------------------------------------

export async function syncExternalPosts(
	env: Env,
	message: SyncPostsMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// 1. Load social account
	const [account] = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
			workspaceId: socialAccounts.workspaceId,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
		})
		.from(socialAccounts)
		.where(eq(socialAccounts.id, message.social_account_id))
		.limit(1);

	if (!account) {
		console.warn(
			`[Sync] Account ${message.social_account_id} not found, skipping`,
		);
		return;
	}

	// 2. Load or init sync state
	let [syncState] = await db
		.select({
			id: socialAccountSyncState.id,
			enabled: socialAccountSyncState.enabled,
			syncCursor: socialAccountSyncState.syncCursor,
			lastPostFoundAt: socialAccountSyncState.lastPostFoundAt,
			pollIntervalSec: socialAccountSyncState.pollIntervalSec,
			consecutiveEmptyPolls: socialAccountSyncState.consecutiveEmptyPolls,
		})
		.from(socialAccountSyncState)
		.where(eq(socialAccountSyncState.socialAccountId, account.id))
		.limit(1);

	if (!syncState) {
		// Auto-init if missing
		const [created] = await db
			.insert(socialAccountSyncState)
			.values({
				socialAccountId: account.id,
				organizationId: account.organizationId,
				platform: account.platform,
				nextSyncAt: new Date(),
			})
			.onConflictDoNothing()
			.returning();
		syncState = created ?? (await db
			.select({
				id: socialAccountSyncState.id,
				enabled: socialAccountSyncState.enabled,
				syncCursor: socialAccountSyncState.syncCursor,
				lastPostFoundAt: socialAccountSyncState.lastPostFoundAt,
				pollIntervalSec: socialAccountSyncState.pollIntervalSec,
				consecutiveEmptyPolls: socialAccountSyncState.consecutiveEmptyPolls,
			})
			.from(socialAccountSyncState)
			.where(eq(socialAccountSyncState.socialAccountId, account.id))
			.limit(1)
		)[0];
		if (!syncState) return;
	}

	if (!syncState.enabled) return;

	// 3. Get platform fetcher
	const fetcher = getExternalPostFetcher(message.platform);
	if (!fetcher) {
		console.warn(`[Sync] No fetcher for platform ${message.platform}`);
		return;
	}

	// 4. Refresh token if needed
	let accessToken: string;
	try {
		accessToken = await refreshTokenIfNeeded(env, account);
	} catch (err) {
		console.error(`[Sync] Token refresh failed for ${account.id}:`, err);
		await updateSyncStateError(
			db,
			syncState.id,
			`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// 5. Fetch posts (paginate up to MAX_PAGES_PER_RUN)
	let pagesProcessed = 0;
	let totalNewPosts = 0;
	let cursor = syncState.syncCursor;
	let lastRateLimit: { remaining: number; resetAt: Date } | undefined;

	try {
		while (pagesProcessed < MAX_PAGES_PER_RUN) {
			const result = await fetcher.fetchPosts(
				accessToken,
				account.platformAccountId,
				{
					since: syncState.lastPostFoundAt ?? undefined,
					cursor,
					limit: 25,
				},
			);

			lastRateLimit = result.rateLimit;

			if (result.posts.length > 0) {
				// 6. Filter out posts published through RelayAPI
				const platformPostIds = result.posts.map((p) => p.platformPostId);
				const internalIds = await getInternalPostIds(
					db,
					account.id,
					platformPostIds,
				);

				const newPosts = result.posts.filter(
					(p) => !internalIds.has(p.platformPostId),
				);

				// 7. Upsert into external_posts
				if (newPosts.length > 0) {
					await upsertExternalPosts(
						db,
						account.organizationId,
						account.workspaceId,
						account.id,
						account.platform,
						newPosts,
					);
					totalNewPosts += newPosts.length;
				}
			}

			cursor = result.nextCursor;
			pagesProcessed++;

			if (!result.hasMore) break;
		}

		// 8. Update sync state
		const now = new Date();
		let newPollInterval = syncState.pollIntervalSec;
		let newEmptyPolls = syncState.consecutiveEmptyPolls;

		if (totalNewPosts > 0) {
			newPollInterval = 3600; // Reset to 1h
			newEmptyPolls = 0;
		} else {
			newEmptyPolls++;
			newPollInterval = Math.min(syncState.pollIntervalSec * 2, 86400);
		}

		await db
			.update(socialAccountSyncState)
			.set({
				lastSyncAt: now,
				lastPostFoundAt: totalNewPosts > 0 ? now : syncState.lastPostFoundAt,
				nextSyncAt: new Date(now.getTime() + newPollInterval * 1000),
				pollIntervalSec: newPollInterval,
				consecutiveEmptyPolls: newEmptyPolls,
				syncCursor: cursor,
				consecutiveErrors: 0,
				lastError: null,
				totalPostsSynced: sql`${socialAccountSyncState.totalPostsSynced} + ${totalNewPosts}`,
				totalSyncRuns: sql`${socialAccountSyncState.totalSyncRuns} + 1`,
				rateLimitRemaining: lastRateLimit?.remaining ?? null,
				rateLimitResetAt: lastRateLimit?.resetAt ?? null,
				updatedAt: now,
			})
			.where(eq(socialAccountSyncState.id, syncState.id));

		// 9. If more pages remain, re-enqueue
		if (cursor && pagesProcessed >= MAX_PAGES_PER_RUN) {
			await env.SYNC_QUEUE.send({
				type: "sync_posts",
				social_account_id: message.social_account_id,
				organization_id: message.organization_id,
				platform: message.platform,
			} satisfies SyncPostsMessage);
		}
	} catch (err) {
		if (err instanceof RateLimitError) {
			// Store rate limit info and let the queue retry with delay
			await db
				.update(socialAccountSyncState)
				.set({
					rateLimitResetAt: err.resetAt,
					rateLimitRemaining: err.remaining,
					nextSyncAt: err.resetAt,
					updatedAt: new Date(),
				})
				.where(eq(socialAccountSyncState.id, syncState.id));
			throw err; // Re-throw for queue consumer to handle
		}

		await updateSyncStateError(
			db,
			syncState.id,
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Metrics refresh: update engagement stats for recent external posts
// ---------------------------------------------------------------------------

export async function refreshExternalPostMetrics(
	env: Env,
	message: RefreshMetricsMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Load account
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(eq(socialAccounts.id, message.social_account_id))
		.limit(1);

	if (!account) return;

	const fetcher = getExternalPostFetcher(message.platform);
	if (!fetcher) return;

	let accessToken: string;
	try {
		accessToken = await refreshTokenIfNeeded(env, account);
	} catch {
		return; // Can't refresh without valid token
	}

	// Load external posts to get platform post IDs
	const posts = await db
		.select({
			id: externalPosts.id,
			platformPostId: externalPosts.platformPostId,
		})
		.from(externalPosts)
		.where(inArray(externalPosts.id, message.external_post_ids));

	if (posts.length === 0) return;

	const platformPostIds = posts.map((p) => p.platformPostId);
	const metricsMap = await fetcher.fetchPostMetrics(
		accessToken,
		account.platformAccountId,
		platformPostIds,
	);

	// Batch-update metrics
	const now = new Date();
	await mapConcurrently(posts, 10, async (post) => {
		const metrics = metricsMap.get(post.platformPostId);
		if (!metrics) return;

		await db
			.update(externalPosts)
			.set({
				metrics,
				metricsUpdatedAt: now,
				updatedAt: now,
			})
			.where(eq(externalPosts.id, post.id));
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check which platformPostIds already exist as internal posts for this account */
async function getInternalPostIds(
	db: Database,
	socialAccountId: string,
	platformPostIds: string[],
): Promise<Set<string>> {
	if (platformPostIds.length === 0) return new Set();

	const rows = await db
		.select({ platformPostId: postTargets.platformPostId })
		.from(postTargets)
		.where(
			and(
				eq(postTargets.socialAccountId, socialAccountId),
				inArray(postTargets.platformPostId, platformPostIds),
			),
		);

	return new Set(
		rows.map((r) => r.platformPostId).filter((id): id is string => id != null),
	);
}

/** Upsert external posts — insert new, update metrics on existing */
async function upsertExternalPosts(
	db: Database,
	organizationId: string,
	workspaceId: string | null,
	socialAccountId: string,
	platform: string,
	posts: import("./types").ExternalPostData[],
): Promise<void> {
	await mapConcurrently(posts, 10, async (post) => {
		await db
			.insert(externalPosts)
			.values({
				organizationId,
				workspaceId,
				socialAccountId,
				platform: platform as any,
				platformPostId: post.platformPostId,
				platformUrl: post.platformUrl,
				content: post.content,
				mediaUrls: post.mediaUrls,
				mediaType: post.mediaType,
				thumbnailUrl: post.thumbnailUrl,
				platformData: post.platformData,
				metrics: post.metrics,
				metricsUpdatedAt: new Date(),
				publishedAt: post.publishedAt,
			})
			.onConflictDoUpdate({
				target: [externalPosts.socialAccountId, externalPosts.platformPostId],
				set: {
					content: post.content,
					mediaUrls: post.mediaUrls,
					mediaType: post.mediaType,
					thumbnailUrl: post.thumbnailUrl,
					platformUrl: post.platformUrl,
					platformData: post.platformData,
					metrics: post.metrics,
					metricsUpdatedAt: new Date(),
					updatedAt: new Date(),
				},
			});
	});
}

/** Update sync state with error info and back off */
async function updateSyncStateError(
	db: Database,
	syncStateId: string,
	errorMessage: string,
): Promise<void> {
	const now = new Date();

	// Read current consecutive errors to calculate backoff
	const [current] = await db
		.select({ consecutiveErrors: socialAccountSyncState.consecutiveErrors })
		.from(socialAccountSyncState)
		.where(eq(socialAccountSyncState.id, syncStateId))
		.limit(1);

	const errors = (current?.consecutiveErrors ?? 0) + 1;
	const backoffSec = Math.min(2 ** errors * 60, 3600); // Cap at 1h

	await db
		.update(socialAccountSyncState)
		.set({
			lastError: errorMessage.slice(0, 1000),
			consecutiveErrors: errors,
			lastErrorAt: now,
			nextSyncAt: new Date(now.getTime() + backoffSec * 1000),
			totalSyncRuns: sql`${socialAccountSyncState.totalSyncRuns} + 1`,
			updatedAt: now,
		})
		.where(eq(socialAccountSyncState.id, syncStateId));
}
