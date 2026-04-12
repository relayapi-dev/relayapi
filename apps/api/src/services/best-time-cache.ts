import {
	createDb,
	postAnalytics,
	postTargets,
	posts,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";

export interface BestTimeSlot {
	day_of_week: number;
	hour_utc: number;
	avg_engagement: number;
	post_count: number;
}

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

function cacheKey(orgId: string): string {
	return `best-time:${orgId}`;
}

/**
 * Get best posting times for an org, using KV cache with 6h TTL.
 * Falls back to a live DB query if cache is empty.
 */
export async function getCachedBestTimes(
	env: Env,
	orgId: string,
): Promise<BestTimeSlot[]> {
	// Try KV cache first
	const cached = await env.KV.get<BestTimeSlot[]>(cacheKey(orgId), "json");
	if (cached) return cached;

	// Compute from DB
	const result = await computeBestTimes(env, orgId);

	// Write to cache (non-blocking)
	void env.KV.put(cacheKey(orgId), JSON.stringify(result), {
		expirationTtl: CACHE_TTL_SECONDS,
	});

	return result;
}

/**
 * Compute best posting times from historical data.
 * Extracted from analytics.ts getBestTime handler.
 */
async function computeBestTimes(
	env: Env,
	orgId: string,
): Promise<BestTimeSlot[]> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Single JOIN: published posts + targets
	const rows = await db
		.select({
			publishedAt: posts.publishedAt,
			targetId: postTargets.id,
		})
		.from(posts)
		.innerJoin(postTargets, eq(postTargets.postId, posts.id))
		.where(
			and(
				eq(posts.organizationId, orgId),
				eq(posts.status, "published"),
			),
		);

	if (rows.length === 0) return [];

	// Batch fetch latest analytics per target
	const targetIds = [...new Set(rows.map((r) => r.targetId))];
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(
		analyticsRows.map((a) => [a.postTargetId, a]),
	);

	// Group engagement by day_of_week + hour
	const timeMap = new Map<string, { totalEngagement: number; count: number }>();

	for (const row of rows) {
		if (!row.publishedAt) continue;
		const dow = row.publishedAt.getUTCDay();
		const hour = row.publishedAt.getUTCHours();
		const key = `${dow}:${hour}`;

		const analytics = analyticsMap.get(row.targetId);
		const engagement = analytics
			? (analytics.likes ?? 0) +
				(analytics.comments ?? 0) +
				(analytics.shares ?? 0)
			: 0;

		const existing = timeMap.get(key) ?? { totalEngagement: 0, count: 0 };
		existing.totalEngagement += engagement;
		existing.count++;
		timeMap.set(key, existing);
	}

	return Array.from(timeMap.entries())
		.map(([key, val]) => {
			const [dow, hour] = key.split(":") as [string, string];
			return {
				day_of_week: Number.parseInt(dow),
				hour_utc: Number.parseInt(hour),
				avg_engagement:
					val.count > 0
						? Math.round((val.totalEngagement / val.count) * 10) / 10
						: 0,
				post_count: val.count,
			};
		})
		.sort((a, b) => b.avg_engagement - a.avg_engagement);
}

/**
 * Get the latest analytics row for each target ID (same logic as analytics.ts).
 */
async function getLatestAnalyticsForTargets(
	db: ReturnType<typeof createDb>,
	targetIds: string[],
) {
	if (targetIds.length === 0) return [];

	// Subquery: latest collectedAt per target
	const latestSq = db
		.select({
			postTargetId: postAnalytics.postTargetId,
			maxCollectedAt: sql<Date>`max(${postAnalytics.collectedAt})`.as(
				"max_collected_at",
			),
		})
		.from(postAnalytics)
		.where(inArray(postAnalytics.postTargetId, targetIds))
		.groupBy(postAnalytics.postTargetId)
		.as("latest");

	return db
		.select({
			postTargetId: postAnalytics.postTargetId,
			likes: postAnalytics.likes,
			comments: postAnalytics.comments,
			shares: postAnalytics.shares,
		})
		.from(postAnalytics)
		.innerJoin(
			latestSq,
			and(
				eq(postAnalytics.postTargetId, latestSq.postTargetId),
				eq(postAnalytics.collectedAt, latestSq.maxCollectedAt),
			),
		);
}
