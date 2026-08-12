import type { Database } from "@relayapi/db";
import { postAnalytics, posts, postTargets } from "@relayapi/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { sha256Hex, stableOperationJson } from "../lib/durable-operation";
import {
	type LegacyAnalyticsScope,
	legacyAnalyticsConditions,
} from "../lib/legacy-analytics-scope";
import type { Env } from "../types";

export interface BestTimeSlot {
	day_of_week: number;
	hour_utc: number;
	avg_engagement: number;
	post_count: number;
}

export type BestTimeFilters = LegacyAnalyticsScope;

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export async function bestTimeCacheKey(
	filters: BestTimeFilters,
): Promise<string> {
	const digest = await sha256Hex(
		stableOperationJson({
			...filters,
			workspaceScope:
				filters.workspaceScope === "all"
					? "all"
					: [...new Set(filters.workspaceScope)].sort(),
			fromDate: filters.fromDate?.toISOString(),
			toDate: filters.toDate?.toISOString(),
		}),
	);
	return `best-time:v2:${digest}`;
}

/**
 * Get scoped best posting times using a filter-specific 6h KV cache.
 * PostgreSQL remains authoritative and the caller's request-scoped database
 * instance is reused so Workers never share a socket across requests.
 */
export async function getCachedBestTimes(
	env: Env,
	db: Database,
	filters: BestTimeFilters,
	// Only waitUntil is used; narrowing keeps Hono's c.executionCtx assignable here.
	executionCtx?: Pick<ExecutionContext, "waitUntil">,
): Promise<BestTimeSlot[]> {
	const key = await bestTimeCacheKey(filters);
	const cached = await env.KV.get<BestTimeSlot[]>(key, "json");
	if (cached) return cached;

	const result = await computeBestTimes(db, filters);
	const write = env.KV.put(key, JSON.stringify(result), {
		expirationTtl: CACHE_TTL_SECONDS,
	}).catch(() => {});
	if (executionCtx) executionCtx.waitUntil(write);
	else void write;

	return result;
}

/**
 * Compute at most one row per UTC weekday/hour in PostgreSQL. The owning
 * post's workspace is applied before any analytics row can contribute.
 */
async function computeBestTimes(
	db: Database,
	filters: BestTimeFilters,
): Promise<BestTimeSlot[]> {
	const conditions = legacyAnalyticsConditions(filters);
	conditions.push(eq(posts.status, "published"), isNotNull(posts.publishedAt));

	const rows = await db.execute<{
		day_of_week: string | number;
		hour_utc: string | number;
		avg_engagement: string | number | null;
		post_count: string | number;
	}>(sql`
		WITH scoped_targets AS (
			SELECT
				${postTargets.id} AS post_target_id,
				${posts.publishedAt} AS published_at
			FROM ${postTargets}
			INNER JOIN ${posts} ON ${postTargets.postId} = ${posts.id}
			WHERE ${and(...conditions)}
		),
		latest AS (
			SELECT DISTINCT ON (${postAnalytics.postTargetId})
				${postAnalytics.postTargetId} AS post_target_id,
				${postAnalytics.likes} AS likes,
				${postAnalytics.comments} AS comments,
				${postAnalytics.shares} AS shares
			FROM ${postAnalytics}
			INNER JOIN scoped_targets
				ON scoped_targets.post_target_id = ${postAnalytics.postTargetId}
			ORDER BY
				${postAnalytics.postTargetId},
				${postAnalytics.collectedAt} DESC,
				${postAnalytics.id} DESC
		)
		SELECT
			EXTRACT(DOW FROM scoped_targets.published_at)::integer AS day_of_week,
			EXTRACT(HOUR FROM scoped_targets.published_at)::integer AS hour_utc,
			AVG(
				COALESCE(latest.likes, 0) +
				COALESCE(latest.comments, 0) +
				COALESCE(latest.shares, 0)
			) AS avg_engagement,
			COUNT(*)::integer AS post_count
		FROM scoped_targets
		LEFT JOIN latest ON latest.post_target_id = scoped_targets.post_target_id
		GROUP BY
			EXTRACT(DOW FROM scoped_targets.published_at),
			EXTRACT(HOUR FROM scoped_targets.published_at)
		ORDER BY avg_engagement DESC, day_of_week, hour_utc
		LIMIT 168
	`);

	type ResultRow = {
		day_of_week: string | number;
		hour_utc: string | number;
		avg_engagement: string | number | null;
		post_count: string | number;
	};
	const result = rows as { rows?: ResultRow[] } & ArrayLike<ResultRow>;
	const raw = result.rows ?? Array.from(result);
	const toNumber = (value: string | number | null) =>
		value == null ? 0 : typeof value === "number" ? value : Number(value);

	return raw.map((row) => ({
		day_of_week: toNumber(row.day_of_week),
		hour_utc: toNumber(row.hour_utc),
		avg_engagement: Math.round(toNumber(row.avg_engagement) * 10) / 10,
		post_count: toNumber(row.post_count),
	}));
}
