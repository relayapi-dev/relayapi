// ---------------------------------------------------------------------------
// External Post Sync — Core Consumer Logic
// ---------------------------------------------------------------------------

import {
	createDb,
	eq,
	externalPosts,
	postTargets,
	socialAccountSyncState,
	socialAccounts,
} from "@relayapi/db";
import { and, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
	classifyProviderReadError,
	exponentialBackoffSeconds,
	EXTERNAL_POST_POLL,
	type ProviderReadErrorClass,
} from "../../lib/async-policy";
import { PLATFORMS, type Platform } from "../../schemas/common";
import type { Env } from "../../types";
import { hasStoredAvatar, rehostAvatar } from "../avatar-store";
import { fetchAvatarUrl } from "../token-refresh";
import { refreshTokenIfNeeded } from "../token-refresh-coordinator";
import { getExternalPostFetcher } from "./index";
import type { GenerateExternalPreviewMessage, SyncPostsMessage } from "./types";
import { RateLimitError } from "./types";

type Database = ReturnType<typeof createDb>;

function parsePlatform(value: string): Platform | null {
	return (PLATFORMS as readonly string[]).includes(value)
		? (value as Platform)
		: null;
}

// ---------------------------------------------------------------------------
// Main sync: fetch posts from a platform and upsert into external_posts
// ---------------------------------------------------------------------------

export async function syncExternalPosts(
	env: Env,
	message: SyncPostsMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const platform = parsePlatform(message.platform);
	if (!platform) return;

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
		.where(
			and(
				eq(socialAccounts.id, message.social_account_id),
				eq(socialAccounts.organizationId, message.organization_id),
				eq(socialAccounts.platform, platform),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
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
			consecutiveErrors: socialAccountSyncState.consecutiveErrors,
			pollGeneration: socialAccountSyncState.pollGeneration,
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
		syncState =
			created ??
			(
				await db
					.select({
						id: socialAccountSyncState.id,
						enabled: socialAccountSyncState.enabled,
						syncCursor: socialAccountSyncState.syncCursor,
						lastPostFoundAt: socialAccountSyncState.lastPostFoundAt,
						pollIntervalSec: socialAccountSyncState.pollIntervalSec,
						consecutiveEmptyPolls: socialAccountSyncState.consecutiveEmptyPolls,
						consecutiveErrors: socialAccountSyncState.consecutiveErrors,
						pollGeneration: socialAccountSyncState.pollGeneration,
					})
					.from(socialAccountSyncState)
					.where(eq(socialAccountSyncState.socialAccountId, account.id))
					.limit(1)
			)[0];
		if (!syncState) return;
	}

	if (!syncState.enabled) return;

	// The scheduled producer has already reserved an exact generation. Manual
	// and webhook-triggered work reaches this path without one and atomically
	// creates its own generation. Either way only one duplicate delivery can
	// move the claim from unstarted to started before provider I/O.
	const claimStartedAt = new Date();
	const claimLeaseExpiresAt = new Date(
		claimStartedAt.getTime() + EXTERNAL_POST_POLL.leaseSeconds * 1000,
	);
	const [claimed] = await db
		.update(socialAccountSyncState)
		.set({
			...(message.poll_generation === undefined
				? {
						pollGeneration: sql`${socialAccountSyncState.pollGeneration} + 1`,
						pollLeaseExpiresAt: claimLeaseExpiresAt,
					}
				: {}),
			pollStartedAt: claimStartedAt,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				eq(socialAccountSyncState.id, syncState.id),
				eq(socialAccountSyncState.enabled, true),
				...(message.poll_generation === undefined
					? [
							or(
								isNull(socialAccountSyncState.pollLeaseExpiresAt),
								lte(socialAccountSyncState.pollLeaseExpiresAt, claimStartedAt),
							),
						]
					: [
							eq(
								socialAccountSyncState.pollGeneration,
								message.poll_generation,
							),
							isNull(socialAccountSyncState.pollStartedAt),
							gt(socialAccountSyncState.pollLeaseExpiresAt, claimStartedAt),
						]),
			),
		)
		.returning({
			pollGeneration: socialAccountSyncState.pollGeneration,
		});
	if (!claimed) return;
	const pollGeneration = claimed.pollGeneration;

	// 3. Get platform fetcher
	const fetcher = getExternalPostFetcher(platform);
	if (!fetcher) {
		await updateSyncStateError(
			db,
			syncState.id,
			pollGeneration,
			claimStartedAt,
			`No external-post fetcher for platform ${message.platform}`,
			"permanent",
			syncState.consecutiveErrors + 1,
		);
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
			pollGeneration,
			claimStartedAt,
			`Token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
			classifyProviderReadError(err),
			syncState.consecutiveErrors + 1,
		);
		return;
	}

	// A RelayAPI URL in the database does not prove its backing object still
	// exists. Verify the durable bucket on every account sync and repair missing
	// objects before post fetching, so a platform-post failure cannot block the
	// avatar migration. Best-effort: sync continues if the provider/avatar fails.
	if (!(await hasStoredAvatar(env, account.id))) {
		try {
			const fresh = await fetchAvatarUrl(
				account.platform as Platform,
				accessToken,
				account.platformAccountId,
			);
			if (fresh) {
				const stable = await rehostAvatar(env, account.id, fresh);
				await db
					.update(socialAccounts)
					.set({ avatarUrl: stable ?? fresh, updatedAt: new Date() })
					.where(eq(socialAccounts.id, account.id));
			}
		} catch (err) {
			console.warn(`[Sync] Avatar re-host failed for ${account.id}:`, err);
		}
	}

	// 5. Fetch posts (paginate up to MAX_PAGES_PER_RUN)
	let pagesProcessed = 0;
	let totalNewPosts = 0;
	let cursor = syncState.syncCursor;
	let lastRateLimit: { remaining: number; resetAt: Date } | undefined;
	let hasMore = false;

	try {
		while (pagesProcessed < EXTERNAL_POST_POLL.maxPagesPerAttempt) {
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
					const previewRows = await upsertExternalPosts(
						db,
						account.organizationId,
						account.workspaceId,
						account.id,
						account.platform,
						newPosts,
					);
					const previewMessages = previewRows
						.filter((row) => row.previewStatus === "pending")
						.map((row): { body: GenerateExternalPreviewMessage } => ({
							body: {
								type: "generate_external_preview",
								external_post_id: row.id,
								organization_id: account.organizationId,
								social_account_id: account.id,
								platform: account.platform,
							},
						}));
					if (previewMessages.length > 0) {
						await env.SYNC_QUEUE.sendBatch(previewMessages);
					}
					totalNewPosts += newPosts.length;
				}
			}

			cursor = result.nextCursor;
			hasMore = result.hasMore;
			pagesProcessed++;

			// Persist continuation after every provider page. A worker crash can
			// repeat at most the in-flight page, not all pages fetched earlier in
			// this delivery.
			const progressed = await db
				.update(socialAccountSyncState)
				.set({ syncCursor: cursor, updatedAt: new Date() })
				.where(
					and(
						eq(socialAccountSyncState.id, syncState.id),
						eq(socialAccountSyncState.pollGeneration, pollGeneration),
						eq(socialAccountSyncState.pollStartedAt, claimStartedAt),
					),
				)
				.returning({ id: socialAccountSyncState.id });
			if (!progressed[0]) return;

			if (!hasMore) break;
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
				// Continuations return to the fair PostgreSQL scheduler instead of
				// self-requeueing and resetting the Queue delivery budget.
				nextSyncAt: hasMore
					? now
					: new Date(now.getTime() + newPollInterval * 1000),
				pollIntervalSec: newPollInterval,
				consecutiveEmptyPolls: newEmptyPolls,
				syncCursor: cursor,
				pollLeaseExpiresAt: null,
				pollStartedAt: null,
				consecutiveErrors: 0,
				lastError: null,
				lastErrorClass: null,
				totalPostsSynced: sql`${socialAccountSyncState.totalPostsSynced} + ${totalNewPosts}`,
				totalSyncRuns: sql`${socialAccountSyncState.totalSyncRuns} + 1`,
				rateLimitRemaining: lastRateLimit?.remaining ?? null,
				rateLimitResetAt: lastRateLimit?.resetAt ?? null,
				updatedAt: now,
			})
			.where(
				and(
					eq(socialAccountSyncState.id, syncState.id),
					eq(socialAccountSyncState.pollGeneration, pollGeneration),
					eq(socialAccountSyncState.pollStartedAt, claimStartedAt),
				),
			);
	} catch (err) {
		if (err instanceof RateLimitError) {
			// PostgreSQL owns the retry schedule. ACK this Queue delivery after the
			// durable rate-limit clock is recorded; stacking Queue retry on the DB
			// schedule would multiply reads after the reset.
			await db
				.update(socialAccountSyncState)
				.set({
					rateLimitResetAt: err.resetAt,
					rateLimitRemaining: err.remaining,
					nextSyncAt: err.resetAt,
					pollLeaseExpiresAt: null,
					pollStartedAt: null,
					consecutiveErrors: sql`${socialAccountSyncState.consecutiveErrors} + 1`,
					lastError: err.message.slice(0, 1000),
					lastErrorClass: "rate_limited",
					lastErrorAt: new Date(),
					totalSyncRuns: sql`${socialAccountSyncState.totalSyncRuns} + 1`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(socialAccountSyncState.id, syncState.id),
						eq(socialAccountSyncState.pollGeneration, pollGeneration),
						eq(socialAccountSyncState.pollStartedAt, claimStartedAt),
					),
				);
			return;
		}

		await updateSyncStateError(
			db,
			syncState.id,
			pollGeneration,
			claimStartedAt,
			err instanceof Error ? err.message : String(err),
			classifyProviderReadError(err),
			syncState.consecutiveErrors + 1,
		);
	}
}

// ---------------------------------------------------------------------------
// Metrics refresh: update engagement stats for recent external posts
// ---------------------------------------------------------------------------

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
): Promise<Array<{ id: string; previewStatus: string }>> {
	if (posts.length === 0) return [];

	// Single multi-row upsert instead of one INSERT per post: the per-row SET
	// columns reference the rejected row via `excluded.*`, so a page of posts is
	// written in one statement (≤25 rows/page) rather than ~25 sequential round
	// trips capped at the pool's max:5 concurrency.
	const now = new Date();
	return db
		.insert(externalPosts)
		.values(
			posts.map((post) => ({
				organizationId,
				workspaceId,
				socialAccountId,
				platform: platform as typeof externalPosts.$inferInsert.platform,
				platformPostId: post.platformPostId,
				platformUrl: post.platformUrl,
				content: post.content,
				mediaUrls: post.mediaUrls,
				mediaType: post.mediaType,
				thumbnailUrl: post.thumbnailUrl,
				platformData: post.platformData,
				metrics: post.metrics,
				metricsUpdatedAt: now,
				publishedAt: post.publishedAt,
			})),
		)
		.onConflictDoUpdate({
			target: [externalPosts.socialAccountId, externalPosts.platformPostId],
			set: {
				content: sql`excluded.content`,
				mediaUrls: sql`excluded.media_urls`,
				mediaType: sql`excluded.media_type`,
				thumbnailUrl: sql`excluded.thumbnail_url`,
				platformUrl: sql`excluded.platform_url`,
				platformData: sql`excluded.platform_data`,
				metrics: sql`excluded.metrics`,
				metricsUpdatedAt: now,
				previewStatus: sql`CASE
					WHEN ${externalPosts.previewThumbnailUrl} IS NULL
					 AND (
						${externalPosts.thumbnailUrl} IS DISTINCT FROM excluded.thumbnail_url
						OR ${externalPosts.mediaUrls} IS DISTINCT FROM excluded.media_urls
					 )
					THEN 'pending'
					ELSE ${externalPosts.previewStatus}
				END`,
				previewNextRetryAt: sql`CASE
					WHEN ${externalPosts.previewThumbnailUrl} IS NULL
					 AND (
						${externalPosts.thumbnailUrl} IS DISTINCT FROM excluded.thumbnail_url
						OR ${externalPosts.mediaUrls} IS DISTINCT FROM excluded.media_urls
					 )
					THEN NULL
					ELSE ${externalPosts.previewNextRetryAt}
				END`,
				previewLastError: sql`CASE
					WHEN ${externalPosts.previewThumbnailUrl} IS NULL
					 AND (
						${externalPosts.thumbnailUrl} IS DISTINCT FROM excluded.thumbnail_url
						OR ${externalPosts.mediaUrls} IS DISTINCT FROM excluded.media_urls
					 )
					THEN NULL
					ELSE ${externalPosts.previewLastError}
				END`,
				updatedAt: now,
			},
		})
		.returning({
			id: externalPosts.id,
			previewStatus: externalPosts.previewStatus,
		});
}

/** Update sync state with error info and back off */
async function updateSyncStateError(
	db: Database,
	syncStateId: string,
	pollGeneration: number,
	claimStartedAt: Date,
	errorMessage: string,
	errorClass: ProviderReadErrorClass,
	attempt: number,
): Promise<void> {
	const now = new Date();
	const backoffSec = exponentialBackoffSeconds(
		attempt,
		EXTERNAL_POST_POLL.retry,
		`${syncStateId}:${attempt}`,
	);
	const budgetExhausted = attempt >= EXTERNAL_POST_POLL.maxAutomaticAttempts;
	const nextSyncAt =
		errorClass === "permanent"
			? new Date(now.getTime() + 24 * 60 * 60 * 1000)
			: new Date(now.getTime() + backoffSec * 1000);
	const persistentMessage = budgetExhausted
		? `Automatic poll attempt budget reached; polling suspended until a manual sync succeeds. ${errorMessage}`
		: errorMessage;

	await db
		.update(socialAccountSyncState)
		.set({
			lastError: persistentMessage.slice(0, 1000),
			lastErrorClass: errorClass,
			consecutiveErrors: sql`${socialAccountSyncState.consecutiveErrors} + 1`,
			lastErrorAt: now,
			nextSyncAt,
			pollLeaseExpiresAt: null,
			pollStartedAt: null,
			totalSyncRuns: sql`${socialAccountSyncState.totalSyncRuns} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(socialAccountSyncState.id, syncStateId),
				eq(socialAccountSyncState.pollGeneration, pollGeneration),
				eq(socialAccountSyncState.pollStartedAt, claimStartedAt),
			),
		);
}
