import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	createDb,
	postAnalytics,
	postTargets,
	posts,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import {
	AnalyticsQuery,
	AnalyticsResponse,
	BestTimeResponse,
	ContentDecayQuery,
	ContentDecayResponse,
	DailyMetricsQuery,
	DailyMetricsResponse,
	PostingFrequencyQuery,
	PostingFrequencyResponse,
	PostTimelineQuery,
	PostTimelineResponse,
	YouTubeDailyViewsQuery,
	YouTubeDailyViewsResponse,
} from "../schemas/analytics";
import {
	ChannelsQuery,
	ChannelsResponse,
	PlatformAnalyticsQuery,
	PlatformAudienceResponse,
	PlatformDailyResponse,
	PlatformOverviewResponse,
	PlatformPostsQuery,
	PlatformPostsResponse,
} from "../schemas/platform-analytics";
import { ErrorResponse } from "../schemas/common";
import {
	PLATFORMS_WITH_ANALYTICS,
	PlatformAnalyticsError,
	hasAnalyticsScopes,
	type DateRange,
	type PlatformOverview,
} from "../services/platform-analytics/types";
import { getPlatformFetcher } from "../services/platform-analytics";
import type { Env, Variables } from "../types";
import { mapConcurrently } from "../lib/concurrency";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const ANALYTICS_OVERVIEW_CACHE_TTL_SECONDS = 300;

// --- Route definitions ---

const getAnalytics = createRoute({
	operationId: "getAnalytics",
	method: "get",
	path: "/",
	tags: ["Analytics"],
	summary: "Get post analytics",
	security: [{ Bearer: [] }],
	request: { query: AnalyticsQuery },
	responses: {
		200: {
			description: "Post analytics",
			content: { "application/json": { schema: AnalyticsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getDailyMetrics = createRoute({
	operationId: "getDailyMetrics",
	method: "get",
	path: "/daily-metrics",
	tags: ["Analytics"],
	summary: "Get daily aggregated metrics",
	security: [{ Bearer: [] }],
	request: { query: DailyMetricsQuery },
	responses: {
		200: {
			description: "Daily metrics",
			content: { "application/json": { schema: DailyMetricsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getBestTime = createRoute({
	operationId: "getBestTime",
	method: "get",
	path: "/best-time",
	tags: ["Analytics"],
	summary: "Get best posting times based on engagement",
	security: [{ Bearer: [] }],
	request: { query: DailyMetricsQuery },
	responses: {
		200: {
			description: "Best posting times",
			content: { "application/json": { schema: BestTimeResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getContentDecay = createRoute({
	operationId: "getContentDecay",
	method: "get",
	path: "/content-decay",
	tags: ["Analytics"],
	summary: "Get engagement decay curve for a post",
	security: [{ Bearer: [] }],
	request: { query: ContentDecayQuery },
	responses: {
		200: {
			description: "Content decay data",
			content: { "application/json": { schema: ContentDecayResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPostTimeline = createRoute({
	operationId: "getPostTimeline",
	method: "get",
	path: "/post-timeline",
	tags: ["Analytics"],
	summary: "Get per-post daily timeline of metrics",
	security: [{ Bearer: [] }],
	request: { query: PostTimelineQuery },
	responses: {
		200: {
			description: "Post timeline data",
			content: { "application/json": { schema: PostTimelineResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPostingFrequency = createRoute({
	operationId: "getPostingFrequency",
	method: "get",
	path: "/posting-frequency",
	tags: ["Analytics"],
	summary: "Get posting frequency vs engagement analysis",
	security: [{ Bearer: [] }],
	request: { query: PostingFrequencyQuery },
	responses: {
		200: {
			description: "Posting frequency data",
			content: {
				"application/json": { schema: PostingFrequencyResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getYouTubeDailyViews = createRoute({
	operationId: "getYouTubeDailyViews",
	method: "get",
	path: "/youtube/daily-views",
	tags: ["Analytics"],
	summary: "Get YouTube daily views and watch time",
	security: [{ Bearer: [] }],
	request: { query: YouTubeDailyViewsQuery },
	responses: {
		200: {
			description: "YouTube daily views",
			content: {
				"application/json": { schema: YouTubeDailyViewsResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Helpers ---

/** Default cap on targets returned to callers — sized for in-memory aggregation. */
const DEFAULT_TARGETS_LIMIT = 1000;
/** Hard upper bound a caller can request. */
const MAX_TARGETS_LIMIT = 5000;

/**
 * Fetches post targets for an org in a single JOIN query (no N+1).
 * Returns only the columns needed for analytics lookups.
 *
 * Pass `limit` to cap the returned rows; callers that need overflow detection
 * should request `limit + 1` and check the length. Default cap is
 * DEFAULT_TARGETS_LIMIT to bound memory on orgs with many published posts.
 */
async function getOrgPostTargetIds(
	db: ReturnType<typeof createDb>,
	orgId: string,
	startDate?: string,
	endDate?: string,
	platform?: string,
	limit: number = DEFAULT_TARGETS_LIMIT,
) {
	const conditions = [eq(posts.organizationId, orgId)];
	if (startDate) conditions.push(gte(posts.publishedAt, new Date(startDate)));
	if (endDate) conditions.push(lte(posts.publishedAt, new Date(endDate)));
	if (platform) conditions.push(eq(postTargets.platform, platform as never));

	const effectiveLimit = Math.min(Math.max(limit, 1), MAX_TARGETS_LIMIT);

	const targets = await db
		.select({
			id: postTargets.id,
			postId: postTargets.postId,
			platform: postTargets.platform,
			publishedAt: postTargets.publishedAt,
			postPublishedAt: posts.publishedAt,
		})
		.from(postTargets)
		.innerJoin(posts, eq(postTargets.postId, posts.id))
		.where(and(...conditions))
		.orderBy(desc(posts.publishedAt))
		.limit(effectiveLimit);

	return targets;
}

/**
 * Computes per-org analytics totals via a SQL aggregate over the DISTINCT-ON
 * latest snapshot per target. Stays O(1) memory in the Worker regardless of
 * how many targets the org has, so overview totals remain correct even when
 * the `data` array is truncated by the target cap.
 */
async function getOrgAnalyticsOverview(
	db: ReturnType<typeof createDb>,
	orgId: string,
	startDate?: string,
	endDate?: string,
	platform?: string,
): Promise<{
	total_posts: number;
	total_impressions: number;
	total_likes: number;
	total_comments: number;
	total_shares: number;
	total_clicks: number;
	total_views: number;
}> {
	const startCond = startDate ? sql`AND p.published_at >= ${new Date(startDate)}` : sql``;
	const endCond = endDate ? sql`AND p.published_at <= ${new Date(endDate)}` : sql``;
	const platformCond = platform ? sql`AND pt.platform = ${platform}` : sql``;

	const rows = await db.execute<{
		total_posts: string | number;
		total_impressions: string | number | null;
		total_likes: string | number | null;
		total_comments: string | number | null;
		total_shares: string | number | null;
		total_clicks: string | number | null;
		total_views: string | number | null;
	}>(sql`
		WITH latest AS (
			SELECT DISTINCT ON (pa.post_target_id)
				pa.post_target_id,
				pa.impressions,
				pa.likes,
				pa.comments,
				pa.shares,
				pa.clicks,
				pa.views
			FROM post_analytics pa
			JOIN post_targets pt ON pt.id = pa.post_target_id
			JOIN posts p ON p.id = pt.post_id
			WHERE p.organization_id = ${orgId}
				${startCond}
				${endCond}
				${platformCond}
			ORDER BY pa.post_target_id, pa.collected_at DESC
		),
		target_count AS (
			SELECT COUNT(*)::bigint AS n
			FROM post_targets pt
			JOIN posts p ON p.id = pt.post_id
			WHERE p.organization_id = ${orgId}
				${startCond}
				${endCond}
				${platformCond}
		)
		SELECT
			(SELECT n FROM target_count) AS total_posts,
			COALESCE(SUM(impressions), 0) AS total_impressions,
			COALESCE(SUM(likes), 0) AS total_likes,
			COALESCE(SUM(comments), 0) AS total_comments,
			COALESCE(SUM(shares), 0) AS total_shares,
			COALESCE(SUM(clicks), 0) AS total_clicks,
			COALESCE(SUM(views), 0) AS total_views
		FROM latest
	`);

	const row = (rows as any).rows?.[0] ?? (rows as any)[0];
	const toNum = (v: string | number | null | undefined) =>
		v == null ? 0 : typeof v === "number" ? v : Number(v);

	return {
		total_posts: toNum(row?.total_posts),
		total_impressions: toNum(row?.total_impressions),
		total_likes: toNum(row?.total_likes),
		total_comments: toNum(row?.total_comments),
		total_shares: toNum(row?.total_shares),
		total_clicks: toNum(row?.total_clicks),
		total_views: toNum(row?.total_views),
	};
}

/**
 * Fetches the latest analytics snapshot for each target in a single query.
 * Uses DISTINCT ON to get one row per postTargetId ordered by collectedAt DESC.
 */
async function getLatestAnalyticsForTargets(
	db: ReturnType<typeof createDb>,
	targetIds: string[],
) {
	if (targetIds.length === 0) return [];

	return db
		.selectDistinctOn([postAnalytics.postTargetId], {
			postTargetId: postAnalytics.postTargetId,
			impressions: postAnalytics.impressions,
			reach: postAnalytics.reach,
			likes: postAnalytics.likes,
			comments: postAnalytics.comments,
			shares: postAnalytics.shares,
			saves: postAnalytics.saves,
			clicks: postAnalytics.clicks,
			views: postAnalytics.views,
			collectedAt: postAnalytics.collectedAt,
		})
		.from(postAnalytics)
		.where(inArray(postAnalytics.postTargetId, targetIds))
		.orderBy(asc(postAnalytics.postTargetId), desc(postAnalytics.collectedAt));
}

// --- Route handlers ---

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getAnalytics, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	// `data` is bounded by MAX_TARGETS_LIMIT so a single response can't explode
	// memory / JSON for very active orgs. `overview` is computed separately via
	// a SQL aggregate, so totals stay accurate even when `data` is truncated.
	const [targets, overview] = await Promise.all([
		getOrgPostTargetIds(
			db,
			orgId,
			query.from_date,
			query.to_date,
			query.platform,
		),
		getOrgAnalyticsOverview(
			db,
			orgId,
			query.from_date,
			query.to_date,
			query.platform,
		),
	]);

	const truncated = overview.total_posts > targets.length;

	if (targets.length === 0) {
		return c.json({ data: [], overview, truncated }, 200);
	}

	// Single batched query for latest analytics per target
	const targetIds = targets.map((t) => t.id);
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(
		analyticsRows.map((a) => [a.postTargetId, a]),
	);

	const data = [];
	for (const target of targets) {
		const latest = analyticsMap.get(target.id);
		if (latest) {
			data.push({
				post_id: target.postId,
				platform: target.platform as string,
				impressions: latest.impressions ?? 0,
				reach: latest.reach ?? 0,
				likes: latest.likes ?? 0,
				comments: latest.comments ?? 0,
				shares: latest.shares ?? 0,
				saves: latest.saves ?? 0,
				clicks: latest.clicks ?? 0,
				views: latest.views ?? null,
				published_at: target.publishedAt?.toISOString() ?? null,
			});
		}
	}

	return c.json({ data, overview, truncated }, 200);
});

app.openapi(getDailyMetrics, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const startDate = query.from_date
		? new Date(query.from_date)
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const endDate = query.to_date ? new Date(query.to_date) : new Date();

	// Single JOIN to get posts + targets in date range
	const rows = await db
		.select({
			postId: posts.id,
			publishedAt: posts.publishedAt,
			targetId: postTargets.id,
			platform: postTargets.platform,
		})
		.from(posts)
		.innerJoin(postTargets, eq(postTargets.postId, posts.id))
		.where(
			and(
				eq(posts.organizationId, orgId),
				gte(posts.publishedAt, startDate),
				lte(posts.publishedAt, endDate),
			),
		)
		.orderBy(posts.publishedAt);

	if (rows.length === 0) return c.json({ data: [] }, 200);

	// Batch fetch latest analytics for all targets
	const targetIds = [...new Set(rows.map((r) => r.targetId))];
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(
		analyticsRows.map((a) => [a.postTargetId, a]),
	);

	// Group by date — track unique postIds per date for post_count
	const dailyMap = new Map<
		string,
		{
			postIds: Set<string>;
			platforms: Record<string, number>;
			impressions: number;
			likes: number;
			comments: number;
			shares: number;
			clicks: number;
			views: number;
		}
	>();

	for (const row of rows) {
		if (!row.publishedAt) continue;
		const dateStr = row.publishedAt.toISOString().split("T")[0]!;

		let existing = dailyMap.get(dateStr);
		if (!existing) {
			existing = {
				postIds: new Set(),
				platforms: {},
				impressions: 0,
				likes: 0,
				comments: 0,
				shares: 0,
				clicks: 0,
				views: 0,
			};
			dailyMap.set(dateStr, existing);
		}

		existing.postIds.add(row.postId);
		existing.platforms[row.platform] =
			(existing.platforms[row.platform] ?? 0) + 1;

		const analytics = analyticsMap.get(row.targetId);
		if (analytics) {
			existing.impressions += analytics.impressions ?? 0;
			existing.likes += analytics.likes ?? 0;
			existing.comments += analytics.comments ?? 0;
			existing.shares += analytics.shares ?? 0;
			existing.clicks += analytics.clicks ?? 0;
			existing.views += analytics.views ?? 0;
		}
	}

	const data = Array.from(dailyMap.entries()).map(([date, metrics]) => ({
		date,
		post_count: metrics.postIds.size,
		platforms: metrics.platforms,
		impressions: metrics.impressions,
		likes: metrics.likes,
		comments: metrics.comments,
		shares: metrics.shares,
		clicks: metrics.clicks,
		views: metrics.views,
	}));

	return c.json({ data }, 200);
});

app.openapi(getBestTime, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");

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

	if (rows.length === 0) return c.json({ data: [] }, 200);

	// Batch fetch latest analytics
	const targetIds = [...new Set(rows.map((r) => r.targetId))];
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(
		analyticsRows.map((a) => [a.postTargetId, a]),
	);

	// Group engagement by day_of_week + hour
	const timeMap = new Map<
		string,
		{ totalEngagement: number; count: number }
	>();

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

	const data = Array.from(timeMap.entries())
		.map(([key, val]) => {
			const [dow, hour] = key.split(":") as [string, string];
			return {
				day_of_week: parseInt(dow),
				hour_utc: parseInt(hour),
				avg_engagement:
					val.count > 0
						? Math.round((val.totalEngagement / val.count) * 10) / 10
						: 0,
				post_count: val.count,
			};
		})
		.sort((a, b) => b.avg_engagement - a.avg_engagement);

	return c.json({ data }, 200);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getContentDecay, async (c) => {
	const orgId = c.get("orgId");
	const { post_id } = c.req.valid("query");
	const db = c.get("db");

	// Verify post ownership
	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, post_id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json(
			{
				post_id,
				platform: "unknown" as const,
				data: [],
				half_life_days: null,
			},
			200,
		);
	}

	const [target] = await db
		.select({ id: postTargets.id, platform: postTargets.platform })
		.from(postTargets)
		.where(eq(postTargets.postId, post_id))
		.limit(1);

	if (!target) {
		return c.json(
			{
				post_id,
				platform: "unknown" as const,
				data: [],
				half_life_days: null,
			},
			200,
		);
	}

	const snapshots = await db
		.select()
		.from(postAnalytics)
		.where(eq(postAnalytics.postTargetId, target.id))
		.orderBy(postAnalytics.collectedAt);

	let cumulativeImpressions = 0;
	let cumulativeEngagement = 0;

	const data = snapshots.map((s, i) => {
		const impressions = s.impressions ?? 0;
		const engagement =
			(s.likes ?? 0) + (s.comments ?? 0) + (s.shares ?? 0);
		cumulativeImpressions += impressions;
		cumulativeEngagement += engagement;

		return {
			day: i,
			impressions,
			engagement,
			cumulative_impressions: cumulativeImpressions,
			cumulative_engagement: cumulativeEngagement,
		};
	});

	return c.json(
		{
			post_id,
			platform: target.platform as string,
			data,
			half_life_days:
				data.length > 1
					? Math.round((data.length / 2) * 10) / 10
					: null,
		},
		200,
	);
});

app.openapi(getPostTimeline, async (c) => {
	const orgId = c.get("orgId");
	const { post_id } = c.req.valid("query");
	const db = c.get("db");

	const [post] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.id, post_id), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post) {
		return c.json({ post_id, data: [] }, 200);
	}

	// Get all target IDs for this post, then batch-fetch all snapshots
	const targets = await db
		.select({ id: postTargets.id })
		.from(postTargets)
		.where(eq(postTargets.postId, post_id));

	const targetIds = targets.map((t) => t.id);
	if (targetIds.length === 0) {
		return c.json({ post_id, data: [] }, 200);
	}

	// Single query for all snapshots across all targets
	const snapshots = await db
		.select()
		.from(postAnalytics)
		.where(inArray(postAnalytics.postTargetId, targetIds));

	// Aggregate by date in memory
	const dateMap = new Map<
		string,
		{
			impressions: number;
			likes: number;
			comments: number;
			shares: number;
			clicks: number;
			views: number;
		}
	>();

	for (const s of snapshots) {
		const dateStr = s.collectedAt.toISOString().split("T")[0]!;
		const existing = dateMap.get(dateStr) ?? {
			impressions: 0,
			likes: 0,
			comments: 0,
			shares: 0,
			clicks: 0,
			views: 0,
		};
		existing.impressions += s.impressions ?? 0;
		existing.likes += s.likes ?? 0;
		existing.comments += s.comments ?? 0;
		existing.shares += s.shares ?? 0;
		existing.clicks += s.clicks ?? 0;
		existing.views += s.views ?? 0;
		dateMap.set(dateStr, existing);
	}

	const data = Array.from(dateMap.entries())
		.map(([date, metrics]) => ({ date, ...metrics }))
		.sort((a, b) => a.date.localeCompare(b.date));

	return c.json({ post_id, data }, 200);
});

app.openapi(getPostingFrequency, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");

	// Single JOIN: published posts + targets
	const rows = await db
		.select({
			postId: posts.id,
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
		)
		.orderBy(posts.publishedAt);

	if (rows.length === 0) {
		return c.json({ data: [], optimal_frequency: 0 }, 200);
	}

	// Batch fetch latest analytics
	const targetIds = [...new Set(rows.map((r) => r.targetId))];
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(
		analyticsRows.map((a) => [a.postTargetId, a]),
	);

	// Group by ISO week
	const weekMap = new Map<
		string,
		{ count: number; totalEngagement: number; totalImpressions: number; postIds: Set<string> }
	>();

	for (const row of rows) {
		if (!row.publishedAt) continue;
		const date = row.publishedAt;
		const weekStart = new Date(date);
		weekStart.setDate(date.getDate() - date.getDay());
		const weekKey = weekStart.toISOString().split("T")[0]!;

		let existing = weekMap.get(weekKey);
		if (!existing) {
			existing = { count: 0, totalEngagement: 0, totalImpressions: 0, postIds: new Set() };
			weekMap.set(weekKey, existing);
		}

		// Count unique posts per week (not targets)
		if (!existing.postIds.has(row.postId)) {
			existing.postIds.add(row.postId);
			existing.count++;
		}

		const analytics = analyticsMap.get(row.targetId);
		if (analytics) {
			existing.totalEngagement +=
				(analytics.likes ?? 0) +
				(analytics.comments ?? 0) +
				(analytics.shares ?? 0);
			existing.totalImpressions += analytics.impressions ?? 0;
		}
	}

	const weekData = Array.from(weekMap.values());

	// Group by posts_per_week frequency
	const freqMap = new Map<
		number,
		{
			totalEngagement: number;
			totalImpressions: number;
			weekCount: number;
		}
	>();

	for (const week of weekData) {
		const freq = week.count;
		const existing = freqMap.get(freq) ?? {
			totalEngagement: 0,
			totalImpressions: 0,
			weekCount: 0,
		};
		existing.totalEngagement += week.totalEngagement;
		existing.totalImpressions += week.totalImpressions;
		existing.weekCount++;
		freqMap.set(freq, existing);
	}

	const data = Array.from(freqMap.entries()).map(([freq, val]) => ({
		posts_per_week: freq,
		avg_engagement:
			val.weekCount > 0
				? Math.round((val.totalEngagement / val.weekCount) * 10) / 10
				: 0,
		avg_impressions:
			val.weekCount > 0
				? Math.round(val.totalImpressions / val.weekCount)
				: 0,
		sample_weeks: val.weekCount,
	}));

	// Find optimal frequency (highest avg engagement)
	const optimalFreq = data.reduce(
		(best, curr) =>
			curr.avg_engagement > (best?.avg_engagement ?? 0) ? curr : best,
		data[0],
	);

	return c.json(
		{
			data,
			optimal_frequency: optimalFreq?.posts_per_week ?? 0,
		},
		200,
	);
});

app.openapi(getYouTubeDailyViews, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const startDate = query.from_date
		? new Date(query.from_date)
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const endDate = query.to_date ? new Date(query.to_date) : new Date();

	// Single JOIN for YouTube targets
	const targets = await getOrgPostTargetIds(
		db,
		orgId,
		startDate.toISOString(),
		endDate.toISOString(),
		"youtube",
	);

	if (targets.length === 0) return c.json({ data: [] }, 200);

	// Single batch query for all snapshots within date range
	const targetIds = targets.map((t) => t.id);
	const snapshots = await db
		.select({
			views: postAnalytics.views,
			collectedAt: postAnalytics.collectedAt,
		})
		.from(postAnalytics)
		.where(
			and(
				inArray(postAnalytics.postTargetId, targetIds),
				gte(postAnalytics.collectedAt, startDate),
				lte(postAnalytics.collectedAt, endDate),
			),
		);

	const dateMap = new Map<
		string,
		{ views: number; watch_time_minutes: number; subscribers_gained: number }
	>();

	for (const s of snapshots) {
		const dateStr = s.collectedAt.toISOString().split("T")[0]!;
		const existing = dateMap.get(dateStr) ?? {
			views: 0,
			watch_time_minutes: 0,
			subscribers_gained: 0,
		};
		existing.views += s.views ?? 0;
		dateMap.set(dateStr, existing);
	}

	const data = Array.from(dateMap.entries())
		.map(([date, metrics]) => ({ date, ...metrics }))
		.sort((a, b) => a.date.localeCompare(b.date));

	return c.json({ data }, 200);
});

// =============================================================================
// Platform Analytics — live data from each platform's native API
// =============================================================================

function getPlatformDateRange(fromDate?: string, toDate?: string): DateRange {
	const to = toDate || new Date().toISOString().split("T")[0]!;
	const from =
		fromDate ||
		new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
			.toISOString()
			.split("T")[0]!;
	return { from, to };
}

async function getAccountWithToken(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey?: string,
) {
	const [account] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
			scopes: socialAccounts.scopes,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			metadata: socialAccounts.metadata,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!account) return null;
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
	};
}

async function getCachedPlatformOverview(
	env: Env,
	executionCtx: ExecutionContext,
	account: {
		id: string;
		platform: string;
		platformAccountId: string;
		accessToken: string;
	},
	dateRange: DateRange,
): Promise<PlatformOverview | null> {
	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) return null;

	const cacheKey =
		`analytics:overview:${account.id}:${dateRange.from}:${dateRange.to}`;
	const cached = await env.KV.get<PlatformOverview>(cacheKey, "json");
	if (cached) return cached;

	const overview = await fetcher.getOverview(
		account.accessToken,
		account.platformAccountId,
		dateRange,
	);
	executionCtx.waitUntil(
		env.KV.put(cacheKey, JSON.stringify(overview), {
			expirationTtl: ANALYTICS_OVERVIEW_CACHE_TTL_SECONDS,
		}),
	);
	return overview;
}

const getChannels = createRoute({
	operationId: "getAnalyticsChannels",
	method: "get",
	path: "/channels",
	tags: ["Platform Analytics"],
	summary: "Get all connected channels with summary analytics",
	security: [{ Bearer: [] }],
	request: { query: ChannelsQuery },
	responses: {
		200: {
			description: "Channel summaries",
			content: { "application/json": { schema: ChannelsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPlatformOverview = createRoute({
	operationId: "getPlatformOverview",
	method: "get",
	path: "/platform/overview",
	tags: ["Platform Analytics"],
	summary: "Get platform-specific overview analytics for an account",
	security: [{ Bearer: [] }],
	request: { query: PlatformAnalyticsQuery },
	responses: {
		200: {
			description: "Platform overview",
			content: { "application/json": { schema: PlatformOverviewResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPlatformPosts = createRoute({
	operationId: "getPlatformPosts",
	method: "get",
	path: "/platform/posts",
	tags: ["Platform Analytics"],
	summary: "Get post-level metrics from the platform API",
	security: [{ Bearer: [] }],
	request: { query: PlatformPostsQuery },
	responses: {
		200: {
			description: "Post metrics",
			content: { "application/json": { schema: PlatformPostsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPlatformAudience = createRoute({
	operationId: "getPlatformAudience",
	method: "get",
	path: "/platform/audience",
	tags: ["Platform Analytics"],
	summary: "Get audience demographics from the platform API",
	security: [{ Bearer: [] }],
	request: { query: PlatformAnalyticsQuery },
	responses: {
		200: {
			description: "Audience demographics",
			content: { "application/json": { schema: PlatformAudienceResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getPlatformDaily = createRoute({
	operationId: "getPlatformDaily",
	method: "get",
	path: "/platform/daily",
	tags: ["Platform Analytics"],
	summary: "Get daily time series metrics from the platform API",
	security: [{ Bearer: [] }],
	request: { query: PlatformAnalyticsQuery },
	responses: {
		200: {
			description: "Daily metrics",
			content: { "application/json": { schema: PlatformDailyResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getChannels, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");
	const dateRange = getPlatformDateRange(query.from_date, query.to_date);

	const conditions = [eq(socialAccounts.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, socialAccounts.workspaceId);

	const rawAccounts = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
			scopes: socialAccounts.scopes,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
		})
		.from(socialAccounts)
		.where(and(...conditions));
	const channelResults = await mapConcurrently(rawAccounts, 4, async (account) => {
		const hasAnalytics = PLATFORMS_WITH_ANALYTICS.includes(account.platform);
		let needsReconnect =
			hasAnalytics && !hasAnalyticsScopes(account.platform, account.scopes);

		let followers: number | null = null;
		let impressions: number | null = null;
		let engagementRate: number | null = null;
		let engagement = 0;

		if (hasAnalytics && !needsReconnect && account.accessToken) {
			try {
				const accessToken = await maybeDecrypt(account.accessToken, c.env.ENCRYPTION_KEY);
				if (accessToken) {
					const overview = await getCachedPlatformOverview(
						c.env,
						c.executionCtx,
						{
							id: account.id,
							platform: account.platform,
							platformAccountId: account.platformAccountId,
							accessToken,
						},
						dateRange,
					);
					if (overview) {
						followers = overview.followers;
						impressions = overview.impressions;
						engagementRate = overview.engagement_rate;
						engagement = overview.engagement ?? 0;
					}
				}
			} catch (err) {
				if (err instanceof PlatformAnalyticsError && (err.code === "TOKEN_EXPIRED" || err.code === "MISSING_PERMISSIONS")) {
					needsReconnect = true;
				}
				console.error(
					`[Platform Analytics] Failed to fetch overview for ${account.platform}/${account.id}:`,
					err,
				);
			}
		}

		return {
			channel: {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
				avatar_url: account.avatarUrl,
				followers,
				impressions,
				engagement_rate: engagementRate,
				has_analytics: hasAnalytics,
				needs_reconnect: needsReconnect,
			},
			followers: followers ?? 0,
			impressions: impressions ?? 0,
			engagement,
		};
	});

	const channels = channelResults.map((result) => result.channel);
	const totalAudience = channelResults.reduce((sum, result) => sum + result.followers, 0);
	const totalImpressions = channelResults.reduce((sum, result) => sum + result.impressions, 0);
	const totalEngagement = channelResults.reduce((sum, result) => sum + result.engagement, 0);

	return c.json(
		{
			data: channels,
			totals: {
				total_audience: totalAudience,
				total_impressions: totalImpressions,
				total_engagement: totalEngagement,
				audience_change: null,
				impressions_change: null,
				engagement_change: null,
			},
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformOverview, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(db, query.account_id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json(
			{ error: { code: "NO_TOKEN", message: "Account has no access token" } },
			400,
		);
	}

	if (!hasAnalyticsScopes(account.platform, account.scopes)) {
		return c.json(
			{
				error: {
					code: "MISSING_SCOPES",
					message:
						"Account is missing required analytics scopes. Please reconnect the account.",
				},
			},
			403,
		);
	}

	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) {
		return c.json(
			{
				error: {
					code: "NO_ANALYTICS",
					message: `Analytics not available for ${account.platform}`,
				},
			},
			400,
		);
	}

	const dateRange = getPlatformDateRange(query.from_date, query.to_date);
	try {
		const overview = await getCachedPlatformOverview(
			c.env,
			c.executionCtx,
			{
				id: account.id,
				platform: account.platform,
				platformAccountId: account.platformAccountId,
				accessToken: account.accessToken,
			},
			dateRange,
		);
		if (!overview) {
			return c.json(
				{
					error: {
						code: "NO_ANALYTICS",
						message: `Analytics not available for ${account.platform}`,
					},
				},
				400,
			);
		}
		return c.json(overview, 200);
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) {
			const status = err.code === "TOKEN_EXPIRED" ? 401 : err.code === "MISSING_PERMISSIONS" ? 403 : 502;
			return c.json({ error: { code: err.code, message: err.message } }, status);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformPosts, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(db, query.account_id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json(
			{ error: { code: "NO_TOKEN", message: "Account has no access token" } },
			400,
		);
	}

	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) {
		return c.json({ data: [] }, 200);
	}

	const dateRange = getPlatformDateRange(query.from_date, query.to_date);
	try {
		const platformPosts = await fetcher.getPostMetrics(
			account.accessToken,
			account.platformAccountId,
			dateRange,
			query.limit,
		);
		return c.json({ data: platformPosts }, 200);
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) {
			const status = err.code === "TOKEN_EXPIRED" ? 401 : err.code === "MISSING_PERMISSIONS" ? 403 : 502;
			return c.json({ error: { code: err.code, message: err.message } }, status);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformAudience, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(db, query.account_id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json(
			{ error: { code: "NO_TOKEN", message: "Account has no access token" } },
			400,
		);
	}

	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) {
		return c.json(
			{
				top_cities: [],
				top_countries: [],
				age_gender: [],
				available: false,
			},
			200,
		);
	}

	try {
		const audience = await fetcher.getAudience(
			account.accessToken,
			account.platformAccountId,
		);

		if (!audience) {
			return c.json(
				{
					top_cities: [],
					top_countries: [],
					age_gender: [],
					available: false,
				},
				200,
			);
		}

		return c.json({ ...audience, available: true }, 200);
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) {
			const status = err.code === "TOKEN_EXPIRED" ? 401 : err.code === "MISSING_PERMISSIONS" ? 403 : 502;
			return c.json({ error: { code: err.code, message: err.message } }, status);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformDaily, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(db, query.account_id, orgId, c.env.ENCRYPTION_KEY);
	if (!account) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Account not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	if (!account.accessToken) {
		return c.json(
			{ error: { code: "NO_TOKEN", message: "Account has no access token" } },
			400,
		);
	}

	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) {
		return c.json({ data: [] }, 200);
	}

	const dateRange = getPlatformDateRange(query.from_date, query.to_date);
	try {
		const daily = await fetcher.getDailyMetrics(
			account.accessToken,
			account.platformAccountId,
			dateRange,
		);
		return c.json({ data: daily }, 200);
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) {
			const status = err.code === "TOKEN_EXPIRED" ? 401 : err.code === "MISSING_PERMISSIONS" ? 403 : 502;
			return c.json({ error: { code: err.code, message: err.message } }, status);
		}
		throw err;
	}
});

export default app;
