// ---------------------------------------------------------------------------
// Unified Analytics Refresh — Background metrics collection for all posts
//
// Implements Brandwatch-style decaying refresh schedule:
//   0-1h   after publish → every 15 min
//   1-24h  after publish → every 1h
//   1-7d   after publish → every 6h
//   7-14d  after publish → every 24h
//   14d+   → stop automatic refresh
// ---------------------------------------------------------------------------

import {
	createDb,
	externalPosts,
	postAnalytics,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
	classifyProviderReadError,
	exponentialBackoffSeconds,
	EXTERNAL_METRICS_POLL,
	INTERNAL_METRICS_POLL,
	type ProviderReadErrorClass,
} from "../lib/async-policy";
import { PLATFORMS, type Platform } from "../schemas/common";
import type { Env } from "../types";
import { getPlatformFetcher } from "./platform-analytics";
import type { PlatformPostMetrics } from "./platform-analytics/types";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";

type Database = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// Queue message types
// ---------------------------------------------------------------------------

export interface RefreshInternalMetricsMessage {
	type: "refresh_internal_metrics";
	organization_id: string;
	post_id: string;
	observation_window_start: string;
}

export interface RefreshExternalMetricsBatchMessage {
	type: "refresh_external_metrics_batch";
	organization_id: string;
	social_account_id: string;
	platform: string;
	external_post_ids: string[];
	poll_generation: number;
}

export type AnalyticsQueueMessage =
	| RefreshInternalMetricsMessage
	| RefreshExternalMetricsBatchMessage;

// ---------------------------------------------------------------------------
// Decaying schedule — determines when next refresh is due
// ---------------------------------------------------------------------------

const SCHEDULE_INTERVALS = [
	{ maxAge: 1 * 3600_000, interval: 15 * 60_000 }, // 0-1h: every 15min
	{ maxAge: 24 * 3600_000, interval: 60 * 60_000 }, // 1-24h: every 1h
	{ maxAge: 7 * 86400_000, interval: 6 * 3600_000 }, // 1-7d: every 6h
	{ maxAge: 14 * 86400_000, interval: 24 * 3600_000 }, // 7-14d: every 24h
];

const OBSERVATION_WINDOW_MS = 5 * 60_000;
const INTERNAL_REFRESH_LEASE_MS = INTERNAL_METRICS_POLL.leaseSeconds * 1_000;

export function analyticsObservationWindowStart(at: Date): Date {
	return new Date(
		Math.floor(at.getTime() / OBSERVATION_WINDOW_MS) * OBSERVATION_WINDOW_MS,
	);
}

function getRefreshInterval(publishedAt: Date, at = new Date()): number | null {
	const age = at.getTime() - publishedAt.getTime();
	for (const tier of SCHEDULE_INTERVALS) {
		if (age < tier.maxAge) return tier.interval;
	}
	return null; // Post is older than 14 days — stop refreshing
}

function nextMetricsPollAt(publishedAt: Date, collectedAt: Date): Date | null {
	const interval = getRefreshInterval(publishedAt, collectedAt);
	return interval === null ? null : new Date(collectedAt.getTime() + interval);
}

// ---------------------------------------------------------------------------
// Cron: enqueue posts needing analytics refresh
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

function parsePlatform(value: string): Platform | null {
	return (PLATFORMS as readonly string[]).includes(value)
		? (value as Platform)
		: null;
}

export async function enqueueAnalyticsRefresh(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const maxAge = new Date(now.getTime() - 14 * 86400_000); // 14 days

	await Promise.allSettled([
		enqueueInternalPostRefresh(db, env, now, maxAge),
		enqueueExternalPostRefresh(db, env, now, maxAge),
	]);
}

async function enqueueInternalPostRefresh(
	db: Database,
	env: Env,
	_now: Date,
	maxAge: Date,
): Promise<void> {
	const observationWindowStart = analyticsObservationWindowStart(_now);
	const leaseExpiresAt = new Date(_now.getTime() + INTERNAL_REFRESH_LEASE_MS);
	const claimed = await db
		.update(posts)
		.set({
			metricsRefreshWindowStart: observationWindowStart,
			metricsRefreshLeaseExpiresAt: leaseExpiresAt,
			metricsRefreshStartedAt: null,
			revision: sql`${posts.revision} + 1`,
			updatedAt: _now,
		})
		.where(
			and(
				eq(posts.status, "published"),
				gt(posts.publishedAt, maxAge),
				lte(posts.metricsNextPollAt, _now),
				sql`${posts.metricsPollAttempts} < ${INTERNAL_METRICS_POLL.maxAutomaticAttempts}`,
				or(
					isNull(posts.metricsRefreshLeaseExpiresAt),
					lte(posts.metricsRefreshLeaseExpiresAt, _now),
				),
				sql`${posts.id} IN (
					SELECT ranked.id
					FROM (
						SELECT
							p.id,
							p.organization_id,
							p.metrics_next_poll_at,
							row_number() OVER (
								PARTITION BY p.organization_id
								ORDER BY p.metrics_next_poll_at, p.id
							) AS tenant_rank
						FROM posts p
						WHERE p.status = 'published'
							AND p.published_at > ${maxAge}
							AND p.metrics_next_poll_at <= ${_now}
							AND p.metrics_poll_attempts < ${INTERNAL_METRICS_POLL.maxAutomaticAttempts}
							AND (
								p.metrics_refresh_lease_expires_at IS NULL
								OR p.metrics_refresh_lease_expires_at <= ${_now}
							)
							AND EXISTS (
								SELECT 1
								FROM post_targets pt
								JOIN social_accounts sa
									ON sa.id = pt.social_account_id
									AND sa.organization_id = pt.organization_id
									AND sa.lifecycle_status = 'active'
								WHERE pt.post_id = p.id
									AND pt.organization_id = p.organization_id
									AND pt.status = 'published'
									AND pt.platform_post_id IS NOT NULL
							)
					) ranked
					WHERE ranked.tenant_rank <= ${INTERNAL_METRICS_POLL.maxClaimsPerTenant}
					ORDER BY
						ranked.tenant_rank,
						ranked.metrics_next_poll_at,
						ranked.organization_id,
						ranked.id
					LIMIT ${INTERNAL_METRICS_POLL.maxClaimsPerRun}
				)`,
			),
		)
		.returning({ id: posts.id, organizationId: posts.organizationId });
	const dueMessages: { body: RefreshInternalMetricsMessage }[] = claimed.map(
		(post) => ({
			body: {
				type: "refresh_internal_metrics",
				organization_id: post.organizationId,
				post_id: post.id,
				observation_window_start: observationWindowStart.toISOString(),
			},
		}),
	);

	if (dueMessages.length === 0) return;

	try {
		for (let i = 0; i < dueMessages.length; i += BATCH_SIZE) {
			await env.SYNC_QUEUE.sendBatch(dueMessages.slice(i, i + BATCH_SIZE));
		}
	} catch (error) {
		await db
			.update(posts)
			.set({
				metricsNextPollAt: _now,
				metricsRefreshLeaseExpiresAt: null,
				metricsRefreshStartedAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					inArray(
						posts.id,
						claimed.map(({ id }) => id),
					),
					eq(posts.metricsRefreshWindowStart, observationWindowStart),
					isNull(posts.metricsRefreshStartedAt),
				),
			);
		throw error;
	}

	console.log(
		`[Analytics Cron] Enqueued ${dueMessages.length} internal post metric refreshes`,
	);
}

async function enqueueExternalPostRefresh(
	db: Database,
	env: Env,
	_now: Date,
	maxAge: Date,
): Promise<void> {
	// Claim and return due rows in one statement. Freshness
	// (metrics_updated_at) is never used as a reservation marker.
	const leaseExpiresAt = new Date(
		_now.getTime() + EXTERNAL_METRICS_POLL.leaseSeconds * 1000,
	);
	const due = await db
		.update(externalPosts)
		.set({
			metricsPollGeneration: sql`${externalPosts.metricsPollGeneration} + 1`,
			metricsPollLeaseExpiresAt: leaseExpiresAt,
			metricsPollStartedAt: null,
			updatedAt: _now,
		})
		.where(
			and(
				gt(externalPosts.publishedAt, maxAge),
				lte(externalPosts.metricsNextPollAt, _now),
				or(
					isNull(externalPosts.metricsPollLeaseExpiresAt),
					lte(externalPosts.metricsPollLeaseExpiresAt, _now),
				),
				sql`${externalPosts.metricsPollAttempts} < ${EXTERNAL_METRICS_POLL.maxAutomaticAttempts}`,
				sql`${externalPosts.id} IN (
					SELECT ranked.id
					FROM (
						SELECT
							ep.id,
							ep.organization_id,
							ep.metrics_next_poll_at,
							row_number() OVER (
								PARTITION BY ep.organization_id
								ORDER BY ep.metrics_next_poll_at, ep.id
							) AS tenant_rank
						FROM external_posts ep
						JOIN social_accounts sa
							ON sa.id = ep.social_account_id
							AND sa.organization_id = ep.organization_id
							AND sa.lifecycle_status = 'active'
						WHERE ep.published_at > ${maxAge}
							AND ep.metrics_next_poll_at <= ${_now}
							AND ep.metrics_poll_attempts < ${EXTERNAL_METRICS_POLL.maxAutomaticAttempts}
							AND (
								ep.metrics_poll_lease_expires_at IS NULL
								OR ep.metrics_poll_lease_expires_at <= ${_now}
							)
					) ranked
					WHERE ranked.tenant_rank <= ${EXTERNAL_METRICS_POLL.maxClaimsPerTenant}
					ORDER BY
						ranked.tenant_rank,
						ranked.metrics_next_poll_at,
						ranked.organization_id,
						ranked.id
					LIMIT ${EXTERNAL_METRICS_POLL.maxClaimsPerRun}
				)`,
			),
		)
		.returning({
			id: externalPosts.id,
			socialAccountId: externalPosts.socialAccountId,
			organizationId: externalPosts.organizationId,
			platform: externalPosts.platform,
			pollGeneration: externalPosts.metricsPollGeneration,
		});

	if (due.length === 0) return;

	// Group by social account for batching
	const byAccount = new Map<
		string,
		{
			accountId: string;
			organizationId: string;
			platform: string;
			pollGeneration: number;
			postIds: string[];
		}
	>();

	for (const post of due) {
		const key = `${post.socialAccountId}:${post.pollGeneration}`;
		let entry = byAccount.get(key);
		if (!entry) {
			entry = {
				accountId: post.socialAccountId,
				organizationId: post.organizationId,
				platform: post.platform,
				pollGeneration: post.pollGeneration,
				postIds: [],
			};
			byAccount.set(key, entry);
		}
		entry.postIds.push(post.id);
	}

	const messages: { body: RefreshExternalMetricsBatchMessage }[] = [];
	for (const data of byAccount.values()) {
		for (
			let i = 0;
			i < data.postIds.length;
			i += EXTERNAL_METRICS_POLL.batchSize
		) {
			messages.push({
				body: {
					type: "refresh_external_metrics_batch",
					organization_id: data.organizationId,
					social_account_id: data.accountId,
					platform: data.platform,
					external_post_ids: data.postIds.slice(
						i,
						i + EXTERNAL_METRICS_POLL.batchSize,
					),
					poll_generation: data.pollGeneration,
				},
			});
		}
	}

	for (let i = 0; i < messages.length; i += BATCH_SIZE) {
		await env.SYNC_QUEUE.sendBatch(messages.slice(i, i + BATCH_SIZE));
	}

	console.log(
		`[Analytics Cron] Enqueued ${messages.length} external metric refresh batches (${due.length} posts)`,
	);
}

// ---------------------------------------------------------------------------
// Consumer: refresh metrics for an internal post
// ---------------------------------------------------------------------------

export async function refreshInternalPostMetrics(
	env: Env,
	message: RefreshInternalMetricsMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const observationWindowStart = new Date(message.observation_window_start);
	if (Number.isNaN(observationWindowStart.getTime())) {
		throw new Error("invalid analytics observation window");
	}
	const claimStartedAt = new Date();
	const [claimedPost] = await db
		.update(posts)
		.set({
			metricsRefreshStartedAt: claimStartedAt,
			metricsPollAttempts: sql`${posts.metricsPollAttempts} + 1`,
			revision: sql`${posts.revision} + 1`,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				eq(posts.id, message.post_id),
				eq(posts.organizationId, message.organization_id),
				eq(posts.status, "published"),
				eq(posts.metricsRefreshWindowStart, observationWindowStart),
				isNull(posts.metricsRefreshStartedAt),
				gt(posts.metricsRefreshLeaseExpiresAt, claimStartedAt),
			),
		)
		.returning({
			id: posts.id,
			publishedAt: posts.publishedAt,
			attempts: posts.metricsPollAttempts,
		});
	if (!claimedPost) return;

	// Load the post's published targets with their social accounts
	const targets = await db
		.select({
			targetId: postTargets.id,
			platform: postTargets.platform,
			platformPostId: postTargets.platformPostId,
			socialAccountId: postTargets.socialAccountId,
			publishedAt: postTargets.publishedAt,
			accountAccessToken: socialAccounts.accessToken,
			accountRefreshToken: socialAccounts.refreshToken,
			accountTokenExpiresAt: socialAccounts.tokenExpiresAt,
			accountPlatformId: socialAccounts.platformAccountId,
			accountPlatform: socialAccounts.platform,
			accountId: socialAccounts.id,
			accountScopes: socialAccounts.scopes,
		})
		.from(postTargets)
		.innerJoin(
			socialAccounts,
			eq(postTargets.socialAccountId, socialAccounts.id),
		)
		.where(
			and(
				eq(postTargets.postId, message.post_id),
				eq(postTargets.organizationId, message.organization_id),
				eq(postTargets.status, "published"),
				eq(socialAccounts.organizationId, message.organization_id),
				eq(socialAccounts.lifecycleStatus, "active"),
				sql`${postTargets.platformPostId} IS NOT NULL`,
			),
		);

	if (targets.length === 0) {
		await finishInternalMetricsPollFailure(
			db,
			message,
			observationWindowStart,
			claimStartedAt,
			claimedPost.attempts,
			new Error("No active published targets remain for metrics polling"),
			"permanent",
		);
		return;
	}

	// Aggregate metrics across all targets
	const aggregated = {
		impressions: 0,
		reach: 0,
		likes: 0,
		comments: 0,
		shares: 0,
		saves: 0,
		clicks: 0,
		views: 0,
	};
	let totalEngagement = 0;
	let anyMatch = false;
	let lastFailure: unknown = new Error(
		"Provider returned no metrics for the claimed post",
	);
	let lastFailureClass: ProviderReadErrorClass = "transient";
	const now = new Date();

	// Cache the windowed list-fetch per (account, date-window) so a multi-target
	// post (or multiple targets on the same account) doesn't re-fetch up to 50
	// media items — plus per-item insights calls — once for every target.
	const windowedCache = new Map<string, PlatformPostMetrics[]>();

	for (const target of targets) {
		if (!target.platformPostId) continue;

		const fetcher = getPlatformFetcher(target.platform);
		if (!fetcher) {
			lastFailure = new Error(
				`No analytics fetcher for platform ${target.platform}`,
			);
			lastFailureClass = "permanent";
			continue;
		}

		let accessToken: string;
		try {
			accessToken = await refreshTokenIfNeeded(env, {
				id: target.accountId,
				platform: target.accountPlatform as Platform,
				accessToken: target.accountAccessToken,
				refreshToken: target.accountRefreshToken,
				tokenExpiresAt: target.accountTokenExpiresAt,
			});
		} catch (error) {
			lastFailure = error;
			lastFailureClass = classifyProviderReadError(error);
			continue; // Can't refresh token, skip this target
		}

		try {
			// Use getPostMetrics with a date range covering this post
			const publishDate = target.publishedAt ?? new Date();
			const from = new Date(publishDate.getTime() - 86400_000)
				.toISOString()
				.slice(0, 10);
			const to = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10);

			// Prefer a direct single-post lookup when the platform fetcher
			// exposes one (e.g. Instagram /{media-id}/insights) — this avoids
			// listing up to 50 items + N per-item insights calls just to pull
			// one post. Fall back to the windowed list otherwise, cached per
			// account+window so we never re-list for sibling targets.
			let match: PlatformPostMetrics | undefined;
			if (fetcher.getSinglePostMetrics) {
				match =
					(await fetcher.getSinglePostMetrics(
						accessToken,
						target.accountPlatformId,
						target.platformPostId,
					)) ?? undefined;
			} else {
				const cacheKey = `${target.accountId}:${from}:${to}`;
				let allMetrics = windowedCache.get(cacheKey);
				if (!allMetrics) {
					allMetrics = await fetcher.getPostMetrics(
						accessToken,
						target.accountPlatformId,
						{ from, to },
						50,
					);
					windowedCache.set(cacheKey, allMetrics);
				}
				match = allMetrics.find(
					(m) => m.platform_post_id === target.platformPostId,
				);
			}

			if (match) {
				anyMatch = true;
				// Write to postAnalytics (time-series)
				await db
					.insert(postAnalytics)
					.values({
						postTargetId: target.targetId,
						platform:
							target.platform as typeof postAnalytics.$inferInsert.platform,
						impressions: match.impressions,
						reach: match.reach,
						likes: match.likes,
						comments: match.comments,
						shares: match.shares,
						saves: match.saves,
						clicks: match.clicks,
						views: 0,
						observationWindowStart,
						collectedAt: now,
					})
					.onConflictDoUpdate({
						target: [
							postAnalytics.postTargetId,
							postAnalytics.observationWindowStart,
						],
						set: {
							platform:
								target.platform as typeof postAnalytics.$inferInsert.platform,
							impressions: match.impressions,
							reach: match.reach,
							likes: match.likes,
							comments: match.comments,
							shares: match.shares,
							saves: match.saves,
							clicks: match.clicks,
							views: 0,
							collectedAt: now,
						},
					});

				// Aggregate for snapshot
				aggregated.impressions += match.impressions;
				aggregated.reach += match.reach;
				aggregated.likes += match.likes;
				aggregated.comments += match.comments;
				aggregated.shares += match.shares;
				aggregated.saves += match.saves;
				aggregated.clicks += match.clicks;
				totalEngagement +=
					match.likes + match.comments + match.shares + match.saves;
			}
		} catch (err) {
			lastFailure = err;
			lastFailureClass = classifyProviderReadError(err);
			console.error(
				`[Analytics] Failed to fetch metrics for target ${target.targetId}:`,
				err,
			);
		}
	}

	// If no target produced metrics this run (every platform fetch failed, a
	// token refresh failed, or the post fell outside the windowed list), do NOT
	// overwrite the stored snapshot with all-zeros — that would wipe a valid
	// non-zero snapshot on a transient outage and, because metricsCollectedAt is
	// bumped, could freeze zeros permanently for posts near the 14-day cutoff.
	if (!anyMatch) {
		await finishInternalMetricsPollFailure(
			db,
			message,
			observationWindowStart,
			claimStartedAt,
			claimedPost.attempts,
			lastFailure,
			lastFailureClass,
		);
		return;
	}

	// Calculate engagement rate if we have data
	const engagementRate =
		aggregated.impressions > 0
			? Number(((totalEngagement / aggregated.impressions) * 100).toFixed(2))
			: 0;
	const nextPollAt = claimedPost.publishedAt
		? nextMetricsPollAt(claimedPost.publishedAt, now)
		: null;

	// Update the post's metricsSnapshot for fast Sent tab display
	await db
		.update(posts)
		.set({
			metricsSnapshot: { ...aggregated, engagement_rate: engagementRate },
			metricsCollectedAt: now,
			metricsNextPollAt:
				nextPollAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1_000),
			metricsRefreshLeaseExpiresAt: null,
			metricsRefreshStartedAt: null,
			metricsPollAttempts: 0,
			metricsPollLastError: null,
			metricsPollLastErrorClass: null,
			revision: sql`${posts.revision} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(posts.id, message.post_id),
				eq(posts.organizationId, message.organization_id),
				eq(posts.metricsRefreshWindowStart, observationWindowStart),
				eq(posts.metricsRefreshStartedAt, claimStartedAt),
			),
		);
}

async function finishInternalMetricsPollFailure(
	db: Database,
	message: RefreshInternalMetricsMessage,
	observationWindowStart: Date,
	claimStartedAt: Date,
	attempts: number,
	error: unknown,
	errorClass: ProviderReadErrorClass,
): Promise<void> {
	const failedAt = new Date();
	const retrySeconds = exponentialBackoffSeconds(
		attempts,
		INTERNAL_METRICS_POLL.retry,
		`${message.post_id}:${attempts}`,
	);
	const exhausted = attempts >= INTERNAL_METRICS_POLL.maxAutomaticAttempts;
	const detail = error instanceof Error ? error.message : String(error);
	await db
		.update(posts)
		.set({
			metricsNextPollAt: new Date(
				failedAt.getTime() +
					(errorClass === "permanent" ? 24 * 60 * 60 : retrySeconds) * 1_000,
			),
			metricsRefreshLeaseExpiresAt: null,
			metricsRefreshStartedAt: null,
			metricsPollLastError: (exhausted
				? `Automatic internal metrics attempt budget reached; polling is suspended. ${detail}`
				: detail
			).slice(0, 1_000),
			metricsPollLastErrorClass: errorClass,
			revision: sql`${posts.revision} + 1`,
			updatedAt: failedAt,
		})
		.where(
			and(
				eq(posts.id, message.post_id),
				eq(posts.organizationId, message.organization_id),
				eq(posts.metricsRefreshWindowStart, observationWindowStart),
				eq(posts.metricsRefreshStartedAt, claimStartedAt),
			),
		);
	if (exhausted) {
		console.error("[Analytics] automatic internal metrics polling suspended", {
			organizationId: message.organization_id,
			postId: message.post_id,
			attempts,
			errorClass,
		});
	}
}

// ---------------------------------------------------------------------------
// Consumer: refresh metrics for external posts (batch)
// ---------------------------------------------------------------------------

export async function refreshExternalPostMetricsBatch(
	env: Env,
	message: RefreshExternalMetricsBatchMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const platform = parsePlatform(message.platform);
	if (!platform) return;

	// Load social account
	const [account] = await db
		.select()
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

	if (!account) return;

	// Get the external post fetcher
	const { getExternalPostFetcher } = await import("./external-post-sync/index");
	const fetcher = getExternalPostFetcher(platform);

	// Claim this exact producer generation before any provider read. Duplicate
	// queue deliveries cannot claim rows already started by another consumer.
	const claimStartedAt = new Date();
	const extPosts = await db
		.update(externalPosts)
		.set({
			metricsPollStartedAt: claimStartedAt,
			metricsPollAttempts: sql`${externalPosts.metricsPollAttempts} + 1`,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				inArray(externalPosts.id, message.external_post_ids),
				eq(externalPosts.organizationId, message.organization_id),
				eq(externalPosts.socialAccountId, message.social_account_id),
				eq(externalPosts.platform, platform),
				eq(externalPosts.metricsPollGeneration, message.poll_generation),
				isNull(externalPosts.metricsPollStartedAt),
				gt(externalPosts.metricsPollLeaseExpiresAt, claimStartedAt),
			),
		)
		.returning({
			id: externalPosts.id,
			platformPostId: externalPosts.platformPostId,
			publishedAt: externalPosts.publishedAt,
			attempts: externalPosts.metricsPollAttempts,
		});

	if (extPosts.length === 0) return;
	if (!fetcher) {
		await failExternalMetricsPoll(
			db,
			message,
			claimStartedAt,
			extPosts,
			new Error(`No metrics fetcher for platform ${platform}`),
			"permanent",
		);
		return;
	}

	let accessToken: string;
	try {
		accessToken = await refreshTokenIfNeeded(env, account);
	} catch (error) {
		await failExternalMetricsPoll(db, message, claimStartedAt, extPosts, error);
		return;
	}

	const platformPostIds = extPosts.map((p) => p.platformPostId);
	let metricsMap: Awaited<ReturnType<typeof fetcher.fetchPostMetrics>>;
	try {
		metricsMap = await fetcher.fetchPostMetrics(
			accessToken,
			account.platformAccountId,
			platformPostIds,
		);
	} catch (error) {
		await failExternalMetricsPoll(db, message, claimStartedAt, extPosts, error);
		return;
	}

	const now = new Date();
	await Promise.allSettled(
		extPosts.map((post) => {
			const metrics = metricsMap.get(post.platformPostId);
			const missingDelaySeconds = exponentialBackoffSeconds(
				post.attempts,
				EXTERNAL_METRICS_POLL.retry,
				`${post.id}:${post.attempts}`,
			);
			const nextPollAt = metrics
				? nextMetricsPollAt(post.publishedAt, now)
				: new Date(now.getTime() + missingDelaySeconds * 1000);

			return db
				.update(externalPosts)
				.set({
					...(metrics ? { metrics, metricsUpdatedAt: now } : {}),
					metricsNextPollAt: nextPollAt,
					metricsPollLeaseExpiresAt: null,
					metricsPollStartedAt: null,
					metricsPollAttempts: metrics ? 0 : post.attempts,
					metricsPollLastError: metrics
						? null
						: post.attempts >= EXTERNAL_METRICS_POLL.maxAutomaticAttempts
							? "Automatic metrics poll attempt budget reached; polling is suspended until a manual refresh succeeds"
							: "Provider returned no metrics for the claimed post",
					metricsPollLastErrorClass: metrics ? null : "transient",
					updatedAt: now,
				})
				.where(
					and(
						eq(externalPosts.id, post.id),
						eq(externalPosts.organizationId, message.organization_id),
						eq(externalPosts.socialAccountId, message.social_account_id),
						eq(externalPosts.metricsPollGeneration, message.poll_generation),
						eq(externalPosts.metricsPollStartedAt, claimStartedAt),
					),
				);
		}),
	);
}

async function failExternalMetricsPoll(
	db: Database,
	message: RefreshExternalMetricsBatchMessage,
	claimStartedAt: Date,
	claimedPosts: Array<{ id: string; attempts: number }>,
	error: unknown,
	forcedClass?: "transient" | "rate_limited" | "permanent",
): Promise<void> {
	const failedAt = new Date();
	const errorClass = forcedClass ?? classifyProviderReadError(error);
	const messageText = error instanceof Error ? error.message : String(error);
	await Promise.allSettled(
		claimedPosts.map((post) => {
			const retrySeconds = exponentialBackoffSeconds(
				post.attempts,
				EXTERNAL_METRICS_POLL.retry,
				`${post.id}:${post.attempts}`,
			);
			const budgetExhausted =
				post.attempts >= EXTERNAL_METRICS_POLL.maxAutomaticAttempts;
			const nextPollAt = new Date(
				failedAt.getTime() +
					(errorClass === "permanent" ? 24 * 60 * 60 : retrySeconds) * 1000,
			);
			const persistedError = budgetExhausted
				? `Automatic metrics poll attempt budget reached; polling is suspended until a manual refresh succeeds. ${messageText}`
				: messageText;
			return db
				.update(externalPosts)
				.set({
					metricsPollLeaseExpiresAt: null,
					metricsPollStartedAt: null,
					metricsNextPollAt: nextPollAt,
					metricsPollLastError: persistedError.slice(0, 1000),
					metricsPollLastErrorClass: errorClass,
					updatedAt: failedAt,
				})
				.where(
					and(
						eq(externalPosts.id, post.id),
						eq(externalPosts.organizationId, message.organization_id),
						eq(externalPosts.socialAccountId, message.social_account_id),
						eq(externalPosts.metricsPollGeneration, message.poll_generation),
						eq(externalPosts.metricsPollStartedAt, claimStartedAt),
					),
				);
		}),
	);
}

// ---------------------------------------------------------------------------
// Trigger: schedule first metrics refresh after post publish
// ---------------------------------------------------------------------------

export async function scheduleFirstMetricsRefresh(
	env: Env,
	postId: string,
	orgId: string,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const scheduledAt = new Date(now.getTime() + 15 * 60_000);
	const observationWindowStart = analyticsObservationWindowStart(scheduledAt);
	const leaseExpiresAt = new Date(
		scheduledAt.getTime() + INTERNAL_REFRESH_LEASE_MS,
	);
	const [claimed] = await db
		.update(posts)
		.set({
			metricsNextPollAt: scheduledAt,
			metricsRefreshWindowStart: observationWindowStart,
			metricsRefreshLeaseExpiresAt: leaseExpiresAt,
			metricsRefreshStartedAt: null,
			revision: sql`${posts.revision} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(posts.id, postId),
				eq(posts.organizationId, orgId),
				eq(posts.status, "published"),
				or(
					isNull(posts.metricsRefreshLeaseExpiresAt),
					lte(posts.metricsRefreshLeaseExpiresAt, now),
				),
			),
		)
		.returning({ id: posts.id });
	if (!claimed) return;

	try {
		// Enqueue with 15-minute delay for the first metrics collection.
		await env.SYNC_QUEUE.send(
			{
				type: "refresh_internal_metrics",
				organization_id: orgId,
				post_id: postId,
				observation_window_start: observationWindowStart.toISOString(),
			} satisfies RefreshInternalMetricsMessage,
			{ delaySeconds: 900 },
		);
	} catch (error) {
		// Release only this unstarted reservation. A later cron can enqueue it
		// immediately instead of waiting for the delayed-message lease to expire.
		await db
			.update(posts)
			.set({
				metricsNextPollAt: now,
				metricsRefreshLeaseExpiresAt: null,
				metricsRefreshStartedAt: null,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(posts.id, postId),
					eq(posts.organizationId, orgId),
					eq(posts.metricsRefreshWindowStart, observationWindowStart),
					isNull(posts.metricsRefreshStartedAt),
				),
			);
		throw error;
	}
}
