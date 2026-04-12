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
	postTargets,
	posts,
	socialAccounts,
} from "@relayapi/db";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { Env } from "../types";
import { getPlatformFetcher } from "./platform-analytics";
import type { PlatformPostMetrics } from "./platform-analytics/types";
import { refreshTokenIfNeeded } from "./token-refresh";

type Database = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// Queue message types
// ---------------------------------------------------------------------------

export interface RefreshInternalMetricsMessage {
	type: "refresh_internal_metrics";
	organization_id: string;
	post_id: string;
}

export interface RefreshExternalMetricsBatchMessage {
	type: "refresh_external_metrics_batch";
	organization_id: string;
	social_account_id: string;
	platform: string;
	external_post_ids: string[];
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

function getRefreshInterval(publishedAt: Date): number | null {
	const age = Date.now() - publishedAt.getTime();
	for (const tier of SCHEDULE_INTERVALS) {
		if (age < tier.maxAge) return tier.interval;
	}
	return null; // Post is older than 14 days — stop refreshing
}

function needsRefresh(
	publishedAt: Date,
	lastCollectedAt: Date | null,
): boolean {
	const interval = getRefreshInterval(publishedAt);
	if (interval == null) return false; // Too old

	if (!lastCollectedAt) return true; // Never collected

	const elapsed = Date.now() - lastCollectedAt.getTime();
	return elapsed >= interval;
}

// ---------------------------------------------------------------------------
// Cron: enqueue posts needing analytics refresh
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const MAX_INTERNAL_PER_RUN = 200;
const MAX_EXTERNAL_PER_RUN = 500;
const EXTERNAL_BATCH_SIZE = 50;

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
	now: Date,
	maxAge: Date,
): Promise<void> {
	// Find published internal posts within 14 days that need a metrics refresh
	const candidates = await db
		.select({
			id: posts.id,
			organizationId: posts.organizationId,
			publishedAt: posts.publishedAt,
			metricsCollectedAt: posts.metricsCollectedAt,
		})
		.from(posts)
		.where(
			and(
				eq(posts.status, "published"),
				gt(posts.publishedAt, maxAge),
				// Has at least one published target with a platformPostId
				sql`EXISTS (
					SELECT 1 FROM post_targets
					WHERE post_targets.post_id = posts.id
					AND post_targets.status = 'published'
					AND post_targets.platform_post_id IS NOT NULL
				)`,
			),
		)
		.orderBy(posts.metricsCollectedAt) // nulls first, then oldest
		.limit(MAX_INTERNAL_PER_RUN);

	const dueMessages: { body: RefreshInternalMetricsMessage }[] = [];

	for (const post of candidates) {
		if (!post.publishedAt) continue;
		if (!needsRefresh(post.publishedAt, post.metricsCollectedAt)) continue;

		dueMessages.push({
			body: {
				type: "refresh_internal_metrics",
				organization_id: post.organizationId,
				post_id: post.id,
			},
		});
	}

	if (dueMessages.length === 0) return;

	for (let i = 0; i < dueMessages.length; i += BATCH_SIZE) {
		await env.SYNC_QUEUE.sendBatch(dueMessages.slice(i, i + BATCH_SIZE));
	}

	console.log(
		`[Analytics Cron] Enqueued ${dueMessages.length} internal post metric refreshes`,
	);
}

async function enqueueExternalPostRefresh(
	db: Database,
	env: Env,
	now: Date,
	maxAge: Date,
): Promise<void> {
	// Find external posts within 14 days needing metrics refresh
	const candidates = await db
		.select({
			id: externalPosts.id,
			socialAccountId: externalPosts.socialAccountId,
			organizationId: externalPosts.organizationId,
			platform: externalPosts.platform,
			publishedAt: externalPosts.publishedAt,
			metricsUpdatedAt: externalPosts.metricsUpdatedAt,
		})
		.from(externalPosts)
		.where(gt(externalPosts.publishedAt, maxAge))
		.orderBy(externalPosts.metricsUpdatedAt)
		.limit(MAX_EXTERNAL_PER_RUN);

	// Filter by decaying schedule
	const due = candidates.filter((p) =>
		needsRefresh(p.publishedAt, p.metricsUpdatedAt),
	);

	if (due.length === 0) return;

	// Group by social account for batching
	const byAccount = new Map<
		string,
		{ organizationId: string; platform: string; postIds: string[] }
	>();

	for (const post of due) {
		const key = post.socialAccountId;
		if (!byAccount.has(key)) {
			byAccount.set(key, {
				organizationId: post.organizationId,
				platform: post.platform,
				postIds: [],
			});
		}
		byAccount.get(key)!.postIds.push(post.id);
	}

	const messages: { body: RefreshExternalMetricsBatchMessage }[] = [];
	for (const [accountId, data] of byAccount) {
		for (let i = 0; i < data.postIds.length; i += EXTERNAL_BATCH_SIZE) {
			messages.push({
				body: {
					type: "refresh_external_metrics_batch",
					organization_id: data.organizationId,
					social_account_id: accountId,
					platform: data.platform,
					external_post_ids: data.postIds.slice(
						i,
						i + EXTERNAL_BATCH_SIZE,
					),
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
				eq(postTargets.status, "published"),
				sql`${postTargets.platformPostId} IS NOT NULL`,
			),
		);

	if (targets.length === 0) return;

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
	let totalFollowers = 0;
	const now = new Date();

	for (const target of targets) {
		if (!target.platformPostId) continue;

		const fetcher = getPlatformFetcher(target.platform);
		if (!fetcher) continue;

		let accessToken: string;
		try {
			accessToken = await refreshTokenIfNeeded(env, {
				id: target.accountId,
				platform: target.accountPlatform as any,
				accessToken: target.accountAccessToken,
				refreshToken: target.accountRefreshToken,
				tokenExpiresAt: target.accountTokenExpiresAt,
			});
		} catch {
			continue; // Can't refresh token, skip this target
		}

		try {
			// Use getPostMetrics with a date range covering this post
			const publishDate = target.publishedAt ?? new Date();
			const from = new Date(publishDate.getTime() - 86400_000)
				.toISOString()
				.slice(0, 10);
			const to = new Date(now.getTime() + 86400_000)
				.toISOString()
				.slice(0, 10);

			const allMetrics = await fetcher.getPostMetrics(
				accessToken,
				target.accountPlatformId,
				{ from, to },
				50,
			);

			// Find metrics for this specific post
			const match = allMetrics.find(
				(m) => m.platform_post_id === target.platformPostId,
			);

			if (match) {
				// Write to postAnalytics (time-series)
				await db.insert(postAnalytics).values({
					postTargetId: target.targetId,
					platform: target.platform as any,
					impressions: match.impressions,
					reach: match.reach,
					likes: match.likes,
					comments: match.comments,
					shares: match.shares,
					saves: match.saves,
					clicks: match.clicks,
					views: 0,
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
			console.error(
				`[Analytics] Failed to fetch metrics for target ${target.targetId}:`,
				err,
			);
		}
	}

	// Calculate engagement rate if we have data
	const engagementRate =
		aggregated.impressions > 0
			? Number(
					((totalEngagement / aggregated.impressions) * 100).toFixed(2),
				)
			: 0;

	// Update the post's metricsSnapshot for fast Sent tab display
	await db
		.update(posts)
		.set({
			metricsSnapshot: { ...aggregated, engagement_rate: engagementRate },
			metricsCollectedAt: now,
			updatedAt: now,
		})
		.where(eq(posts.id, message.post_id));
}

// ---------------------------------------------------------------------------
// Consumer: refresh metrics for external posts (batch)
// ---------------------------------------------------------------------------

export async function refreshExternalPostMetricsBatch(
	env: Env,
	message: RefreshExternalMetricsBatchMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Load social account
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(eq(socialAccounts.id, message.social_account_id))
		.limit(1);

	if (!account) return;

	// Get the external post fetcher
	const { getExternalPostFetcher } = await import(
		"./external-post-sync/index"
	);
	const fetcher = getExternalPostFetcher(message.platform);
	if (!fetcher) return;

	let accessToken: string;
	try {
		accessToken = await refreshTokenIfNeeded(env, account);
	} catch {
		return;
	}

	// Load external posts to get platform post IDs
	const extPosts = await db
		.select({
			id: externalPosts.id,
			platformPostId: externalPosts.platformPostId,
		})
		.from(externalPosts)
		.where(inArray(externalPosts.id, message.external_post_ids));

	if (extPosts.length === 0) return;

	const platformPostIds = extPosts.map((p) => p.platformPostId);
	const metricsMap = await fetcher.fetchPostMetrics(
		accessToken,
		account.platformAccountId,
		platformPostIds,
	);

	const now = new Date();
	await Promise.allSettled(
		extPosts.map((post) => {
			const metrics = metricsMap.get(post.platformPostId);
			if (!metrics) return Promise.resolve();

			return db
				.update(externalPosts)
				.set({
					metrics,
					metricsUpdatedAt: now,
					updatedAt: now,
				})
				.where(eq(externalPosts.id, post.id));
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
	// Enqueue with 15-minute delay for the first metrics collection
	await env.SYNC_QUEUE.send(
		{
			type: "refresh_internal_metrics",
			organization_id: orgId,
			post_id: postId,
		} satisfies RefreshInternalMetricsMessage,
		{ delaySeconds: 900 }, // 15 minutes
	);
}
