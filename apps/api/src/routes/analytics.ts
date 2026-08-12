import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	type createDb,
	postAnalytics,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Context } from "hono";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { cumulativeSnapshotsToDecay } from "../lib/analytics-observations";
import { mapConcurrently } from "../lib/concurrency";
import {
	type LegacyAnalyticsScope,
	legacyAnalyticsConditions,
} from "../lib/legacy-analytics-scope";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
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
import { ErrorResponse } from "../schemas/common";
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
import { getCachedBestTimes } from "../services/best-time-cache";
import { getPlatformFetcher } from "../services/platform-analytics";
import {
	type DateRange,
	hasAnalyticsScopes,
	PLATFORMS_WITH_ANALYTICS,
	PlatformAnalyticsError,
	type PlatformOverview,
	type PlatformPostMetrics,
} from "../services/platform-analytics/types";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const ANALYTICS_OVERVIEW_CACHE_TTL_SECONDS = 300;
/** Post-level metrics are expensive (N per-media insights calls); cache longer. */
const ANALYTICS_POSTS_CACHE_TTL_SECONDS = 900; // 15 minutes

const legacyResourceErrorResponses = {
	400: {
		description: "Invalid analytics resource or filter",
		content: { "application/json": { schema: ErrorResponse } },
	},
	403: {
		description: "Workspace access denied",
		content: { "application/json": { schema: ErrorResponse } },
	},
	404: {
		description: "Analytics resource not found",
		content: { "application/json": { schema: ErrorResponse } },
	},
} as const;

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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
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
		...legacyResourceErrorResponses,
	},
});

// --- Helpers ---

/** Default cap on targets returned to callers — sized for in-memory aggregation. */
const DEFAULT_TARGETS_LIMIT = 1000;
/** Hard upper bound a caller can request. */
const MAX_TARGETS_LIMIT = 5000;

type AnalyticsContext = Context<{
	Bindings: Env;
	Variables: Variables;
}>;

async function requireLegacyAnalyticsAccount(
	c: AnalyticsContext,
	accountId: string,
	requiredPlatform?: string,
) {
	const [account] = await c
		.get("db")
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, c.get("orgId")),
			),
		)
		.limit(1);

	if (!account) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Social account not found",
				},
			},
			404,
		);
	}
	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;
	if (requiredPlatform && account.platform !== requiredPlatform) {
		return c.json(
			{
				error: {
					code: "INVALID_ACCOUNT_PLATFORM",
					message: `Account must be a ${requiredPlatform} account`,
				},
			},
			400,
		);
	}
	return account;
}

async function requireLegacyAnalyticsPost(c: AnalyticsContext, postId: string) {
	const [post] = await c
		.get("db")
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, c.get("orgId"))))
		.limit(1);

	if (!post) {
		return c.json(
			{
				error: {
					code: "POST_NOT_FOUND",
					message: "Post not found",
				},
			},
			404,
		);
	}
	return assertWorkspaceScope(c, post.workspaceId) ?? post;
}

/**
 * Fetches post targets for an org in a single JOIN query (no N+1).
 * Returns only the columns needed for analytics lookups.
 *
 * Pass `limit` to cap the returned rows; callers that need overflow detection
 * should request `limit + 1` and check the length. Default cap is
 * DEFAULT_TARGETS_LIMIT to bound memory on orgs with many published posts.
 * Pass `offset` to page through targets (keyset would be better but the caller
 * surface here is a simple validated offset).
 */
async function getOrgPostTargetIds(
	db: ReturnType<typeof createDb>,
	filters: LegacyAnalyticsScope,
	limit: number = DEFAULT_TARGETS_LIMIT,
	offset = 0,
) {
	const conditions = legacyAnalyticsConditions(filters);

	const effectiveLimit = Math.min(Math.max(limit, 1), MAX_TARGETS_LIMIT);
	const effectiveOffset = Math.max(offset, 0);

	const query = db
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
		.orderBy(desc(posts.publishedAt), desc(postTargets.id))
		.limit(effectiveLimit);

	const targets = await (effectiveOffset > 0
		? query.offset(effectiveOffset)
		: query);

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
	filters: LegacyAnalyticsScope,
): Promise<{
	total_posts: number;
	total_impressions: number;
	total_likes: number;
	total_comments: number;
	total_shares: number;
	total_clicks: number;
	total_views: number;
}> {
	const conditions = legacyAnalyticsConditions(filters);
	const where = and(...conditions);

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
			SELECT DISTINCT ON (${postAnalytics.postTargetId})
				${postAnalytics.postTargetId} AS post_target_id,
				${postAnalytics.impressions} AS impressions,
				${postAnalytics.likes} AS likes,
				${postAnalytics.comments} AS comments,
				${postAnalytics.shares} AS shares,
				${postAnalytics.clicks} AS clicks,
				${postAnalytics.views} AS views
			FROM ${postAnalytics}
			JOIN ${postTargets} ON ${postTargets.id} = ${postAnalytics.postTargetId}
			JOIN ${posts} ON ${posts.id} = ${postTargets.postId}
			WHERE ${where}
			ORDER BY ${postAnalytics.postTargetId}, ${postAnalytics.collectedAt} DESC, ${postAnalytics.id} DESC
		),
		target_count AS (
			SELECT COUNT(*)::bigint AS n
			FROM ${postTargets}
			JOIN ${posts} ON ${posts.id} = ${postTargets.postId}
			WHERE ${where}
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

	type TotalsRow = {
		total_posts: string | number;
		total_impressions: string | number | null;
		total_likes: string | number | null;
		total_comments: string | number | null;
		total_shares: string | number | null;
		total_clicks: string | number | null;
		total_views: string | number | null;
	};
	const result = rows as { rows?: TotalsRow[] } & ArrayLike<TotalsRow>;
	const row = result.rows?.[0] ?? result[0];
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
		.orderBy(
			asc(postAnalytics.postTargetId),
			desc(postAnalytics.collectedAt),
			desc(postAnalytics.id),
		);
}

// --- Route handlers ---

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getAnalytics, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");
	if (query.account_id) {
		const account = await requireLegacyAnalyticsAccount(c, query.account_id);
		if (account instanceof Response) return account as never;
	}
	if (query.post_id) {
		const post = await requireLegacyAnalyticsPost(c, query.post_id);
		if (post instanceof Response) return post as never;
	}
	const filters: LegacyAnalyticsScope = {
		organizationId: orgId,
		workspaceScope: c.get("workspaceScope"),
		workspaceId: query.workspace_id,
		accountId: query.account_id,
		postId: query.post_id,
		platform: query.platform,
		fromDate: query.from_date ? new Date(query.from_date) : undefined,
		toDate: query.to_date ? new Date(query.to_date) : undefined,
	};

	// `data` is bounded by the validated `limit` (1-100, default 20) so a single
	// response can't explode memory / JSON for very active orgs. `overview` is
	// computed separately via a SQL aggregate, so totals stay accurate even when
	// `data` is truncated. We request `limit + 1` to detect overflow precisely.
	const [targets, overview] = await Promise.all([
		getOrgPostTargetIds(db, filters, query.limit + 1, query.offset),
		getOrgAnalyticsOverview(db, filters),
	]);

	// Trim the overflow sentinel row before serializing.
	const hasMore = targets.length > query.limit;
	if (hasMore) targets.length = query.limit;
	const nextOffset = hasMore ? query.offset + query.limit : null;
	const truncated = hasMore || overview.total_posts > targets.length;

	if (targets.length === 0) {
		return c.json(
			{
				data: [],
				overview,
				has_more: hasMore,
				next_offset: nextOffset,
				truncated,
			},
			200,
		);
	}

	// Single batched query for latest analytics per target
	const targetIds = targets.map((t) => t.id);
	const analyticsRows = await getLatestAnalyticsForTargets(db, targetIds);
	const analyticsMap = new Map(analyticsRows.map((a) => [a.postTargetId, a]));

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

	return c.json(
		{
			data,
			overview,
			has_more: hasMore,
			next_offset: nextOffset,
			truncated,
		},
		200,
	);
});

app.openapi(getDailyMetrics, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");
	if (query.account_id) {
		const account = await requireLegacyAnalyticsAccount(c, query.account_id);
		if (account instanceof Response) return account as never;
	}

	const startDate = query.from_date
		? new Date(query.from_date)
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const endDate = query.to_date ? new Date(query.to_date) : new Date();
	const conditions = legacyAnalyticsConditions({
		organizationId: orgId,
		workspaceScope: c.get("workspaceScope"),
		workspaceId: query.workspace_id,
		accountId: query.account_id,
		platform: query.platform,
		fromDate: startDate,
		toDate: endDate,
	});

	// Aggregate latest-per-target observations in PostgreSQL. GROUPING SETS
	// returns one totals row and one bounded platform-count row per UTC day, so
	// the Worker never materializes every post target or a giant IN (...) list.
	const dailyRows = await db.execute<{
		date: string;
		platform: string | null;
		post_count: string | number;
		impressions: string | number | null;
		likes: string | number | null;
		comments: string | number | null;
		shares: string | number | null;
		clicks: string | number | null;
		views: string | number | null;
	}>(sql`
		WITH scoped_targets AS (
			SELECT
				${postTargets.id} AS post_target_id,
				${posts.id} AS post_id,
				${posts.publishedAt} AS published_at,
				${postTargets.platform} AS platform
			FROM ${posts}
			INNER JOIN ${postTargets} ON ${postTargets.postId} = ${posts.id}
			WHERE ${and(...conditions)}
				AND ${posts.publishedAt} IS NOT NULL
		),
		latest AS (
			SELECT DISTINCT ON (${postAnalytics.postTargetId})
				${postAnalytics.postTargetId} AS post_target_id,
				${postAnalytics.impressions} AS impressions,
				${postAnalytics.likes} AS likes,
				${postAnalytics.comments} AS comments,
				${postAnalytics.shares} AS shares,
				${postAnalytics.clicks} AS clicks,
				${postAnalytics.views} AS views
			FROM ${postAnalytics}
			INNER JOIN scoped_targets
				ON scoped_targets.post_target_id = ${postAnalytics.postTargetId}
			ORDER BY
				${postAnalytics.postTargetId},
				${postAnalytics.collectedAt} DESC,
				${postAnalytics.id} DESC
		)
		SELECT
			to_char(scoped_targets.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
			CASE WHEN GROUPING(scoped_targets.platform) = 1
				THEN NULL ELSE scoped_targets.platform::text END AS platform,
			COUNT(DISTINCT scoped_targets.post_id)::integer AS post_count,
			COALESCE(SUM(latest.impressions), 0) AS impressions,
			COALESCE(SUM(latest.likes), 0) AS likes,
			COALESCE(SUM(latest.comments), 0) AS comments,
			COALESCE(SUM(latest.shares), 0) AS shares,
			COALESCE(SUM(latest.clicks), 0) AS clicks,
			COALESCE(SUM(latest.views), 0) AS views
		FROM scoped_targets
		LEFT JOIN latest ON latest.post_target_id = scoped_targets.post_target_id
		GROUP BY GROUPING SETS (
			(to_char(scoped_targets.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')),
			(to_char(scoped_targets.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), scoped_targets.platform)
		)
		ORDER BY date, platform NULLS FIRST
	`);

	type DailyRow = {
		date: string;
		platform: string | null;
		post_count: string | number;
		impressions: string | number | null;
		likes: string | number | null;
		comments: string | number | null;
		shares: string | number | null;
		clicks: string | number | null;
		views: string | number | null;
	};
	const dailyResult = dailyRows as { rows?: DailyRow[] } & ArrayLike<DailyRow>;
	const rawDailyRows = dailyResult.rows ?? Array.from(dailyResult);
	const toNumber = (value: string | number | null | undefined) =>
		value == null ? 0 : typeof value === "number" ? value : Number(value);
	const byDate = new Map<
		string,
		{
			date: string;
			post_count: number;
			platforms: Record<string, number>;
			impressions: number;
			likes: number;
			comments: number;
			shares: number;
			clicks: number;
			views: number;
		}
	>();
	for (const row of rawDailyRows) {
		const current = byDate.get(row.date) ?? {
			date: row.date,
			post_count: 0,
			platforms: {},
			impressions: 0,
			likes: 0,
			comments: 0,
			shares: 0,
			clicks: 0,
			views: 0,
		};
		if (row.platform) {
			current.platforms[row.platform] = toNumber(row.post_count);
		} else {
			current.post_count = toNumber(row.post_count);
			current.impressions = toNumber(row.impressions);
			current.likes = toNumber(row.likes);
			current.comments = toNumber(row.comments);
			current.shares = toNumber(row.shares);
			current.clicks = toNumber(row.clicks);
			current.views = toNumber(row.views);
		}
		byDate.set(row.date, current);
	}
	const data = [...byDate.values()].sort((left, right) =>
		left.date.localeCompare(right.date),
	);

	return c.json({ data }, 200);
});

app.openapi(getBestTime, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	if (query.account_id) {
		const account = await requireLegacyAnalyticsAccount(c, query.account_id);
		if (account instanceof Response) return account as never;
	}

	// Route through the shared 6h KV cache. PostgreSQL performs the aggregation
	// and returns at most 168 weekday/hour buckets, while executionCtx.waitUntil
	// keeps cache persistence alive after the response is returned.
	// Response shape (BestTimeSlot[]) is identical; values may be up to 6h stale,
	// consistent with the slot-finder consumer of the same cache.
	const bestTimeTo = query.to_date ? new Date(query.to_date) : new Date();
	const bestTimeFrom = query.from_date
		? new Date(query.from_date)
		: new Date(bestTimeTo.getTime() - 366 * 86_400_000);
	const data = await getCachedBestTimes(
		c.env,
		c.get("db"),
		{
			organizationId: orgId,
			workspaceScope: c.get("workspaceScope"),
			workspaceId: query.workspace_id,
			accountId: query.account_id,
			platform: query.platform,
			fromDate: bestTimeFrom,
			toDate: bestTimeTo,
		},
		c.executionCtx,
	);

	return c.json({ data }, 200);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getContentDecay, async (c) => {
	const { post_id, days } = c.req.valid("query");
	const db = c.get("db");

	const post = await requireLegacyAnalyticsPost(c, post_id);
	if (post instanceof Response) return post as never;

	const [target] = await db
		.select({
			id: postTargets.id,
			platform: postTargets.platform,
			publishedAt: postTargets.publishedAt,
		})
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

	// Honor the documented `days` window: only consider snapshots collected
	// within `days` of publication. Default (30) exceeds the 14-day collection
	// horizon, so default responses are unchanged; smaller values now narrow.
	// Only apply the upper bound when publishedAt is known — otherwise (nullable
	// column, e.g. an imported/partially-published target that still accrued
	// snapshots) anchoring on the epoch would exclude every real snapshot.
	const snapshotConditions = [eq(postAnalytics.postTargetId, target.id)];
	if (target.publishedAt) {
		snapshotConditions.push(
			lte(
				postAnalytics.collectedAt,
				new Date(target.publishedAt.getTime() + days * 86400_000),
			),
		);
	}
	const snapshots = await db
		.select()
		.from(postAnalytics)
		.where(and(...snapshotConditions))
		.orderBy(postAnalytics.collectedAt, postAnalytics.id)
		.limit(500);
	const data = cumulativeSnapshotsToDecay(
		snapshots.map((snapshot) => ({
			...snapshot,
			postTargetId: snapshot.postTargetId,
		})),
		target.publishedAt,
	);

	return c.json(
		{
			post_id,
			platform: target.platform as string,
			data,
			half_life_days:
				data.length > 1 ? Math.round((data.length / 2) * 10) / 10 : null,
		},
		200,
	);
});

app.openapi(getPostTimeline, async (c) => {
	const { post_id, from_date, to_date } = c.req.valid("query");
	const db = c.get("db");

	const post = await requireLegacyAnalyticsPost(c, post_id);
	if (post instanceof Response) return post as never;

	const endDate = to_date ? new Date(to_date) : new Date();
	const startDate = from_date
		? new Date(from_date)
		: new Date(endDate.getTime() - 366 * 86_400_000);

	// Provider counters are cumulative. Select only the deterministic latest
	// value per target/day, turn each target into daily deltas with LAG, then use
	// a cumulative window over the summed deltas. The result is at most one row
	// per requested day regardless of polling frequency or target count.
	const timelineRows = await db.execute<{
		date: string;
		impressions: string | number | null;
		likes: string | number | null;
		comments: string | number | null;
		shares: string | number | null;
		clicks: string | number | null;
		views: string | number | null;
	}>(sql`
		WITH daily_latest AS (
			SELECT DISTINCT ON (
				${postAnalytics.postTargetId},
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date
			)
				${postAnalytics.postTargetId} AS post_target_id,
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date AS day,
				COALESCE(${postAnalytics.impressions}, 0)::bigint AS impressions,
				COALESCE(${postAnalytics.likes}, 0)::bigint AS likes,
				COALESCE(${postAnalytics.comments}, 0)::bigint AS comments,
				COALESCE(${postAnalytics.shares}, 0)::bigint AS shares,
				COALESCE(${postAnalytics.clicks}, 0)::bigint AS clicks,
				COALESCE(${postAnalytics.views}, 0)::bigint AS views
			FROM ${postAnalytics}
			INNER JOIN ${postTargets}
				ON ${postTargets.id} = ${postAnalytics.postTargetId}
			WHERE ${postTargets.postId} = ${post_id}
				AND ${postAnalytics.collectedAt} >= ${startDate}
				AND ${postAnalytics.collectedAt} <= ${endDate}
			ORDER BY
				${postAnalytics.postTargetId},
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date,
				${postAnalytics.collectedAt} DESC,
				${postAnalytics.id} DESC
		),
		deltas AS (
			SELECT
				post_target_id,
				day,
				impressions - COALESCE(LAG(impressions) OVER target_days, 0) AS impressions,
				likes - COALESCE(LAG(likes) OVER target_days, 0) AS likes,
				comments - COALESCE(LAG(comments) OVER target_days, 0) AS comments,
				shares - COALESCE(LAG(shares) OVER target_days, 0) AS shares,
				clicks - COALESCE(LAG(clicks) OVER target_days, 0) AS clicks,
				views - COALESCE(LAG(views) OVER target_days, 0) AS views
			FROM daily_latest
			WINDOW target_days AS (PARTITION BY post_target_id ORDER BY day)
		),
		daily_deltas AS (
			SELECT
				day,
				SUM(impressions) AS impressions,
				SUM(likes) AS likes,
				SUM(comments) AS comments,
				SUM(shares) AS shares,
				SUM(clicks) AS clicks,
				SUM(views) AS views
			FROM deltas
			GROUP BY day
		)
		SELECT
			to_char(day, 'YYYY-MM-DD') AS date,
			SUM(impressions) OVER (ORDER BY day) AS impressions,
			SUM(likes) OVER (ORDER BY day) AS likes,
			SUM(comments) OVER (ORDER BY day) AS comments,
			SUM(shares) OVER (ORDER BY day) AS shares,
			SUM(clicks) OVER (ORDER BY day) AS clicks,
			SUM(views) OVER (ORDER BY day) AS views
		FROM daily_deltas
		ORDER BY day
	`);
	type TimelineRow = {
		date: string;
		impressions: string | number | null;
		likes: string | number | null;
		comments: string | number | null;
		shares: string | number | null;
		clicks: string | number | null;
		views: string | number | null;
	};
	const timelineResult = timelineRows as {
		rows?: TimelineRow[];
	} & ArrayLike<TimelineRow>;
	const toNumber = (value: string | number | null) =>
		value == null ? 0 : typeof value === "number" ? value : Number(value);
	const data = (timelineResult.rows ?? Array.from(timelineResult)).map((row) => ({
		date: row.date,
		impressions: toNumber(row.impressions),
		likes: toNumber(row.likes),
		comments: toNumber(row.comments),
		shares: toNumber(row.shares),
		clicks: toNumber(row.clicks),
		views: toNumber(row.views),
	}));

	return c.json({ post_id, data }, 200);
});

app.openapi(getPostingFrequency, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");
	if (query.account_id) {
		const account = await requireLegacyAnalyticsAccount(c, query.account_id);
		if (account instanceof Response) return account as never;
	}

	// Bucket by ISO week entirely in SQL so the Worker only receives ~one row
	// per week, never the org's full publish history. Engagement is summed from
	// the latest snapshot per target (DISTINCT ON ... ORDER BY collected_at DESC),
	// counting DISTINCT posts per week. Wires up the documented filters.
	const frequencyTo = query.to_date ? new Date(query.to_date) : new Date();
	const frequencyFrom = query.from_date
		? new Date(query.from_date)
		: new Date(frequencyTo.getTime() - 366 * 86_400_000);
	const frequencyConditions = legacyAnalyticsConditions({
		organizationId: orgId,
		workspaceScope: c.get("workspaceScope"),
		workspaceId: query.workspace_id,
		accountId: query.account_id,
		platform: query.platform,
		fromDate: frequencyFrom,
		toDate: frequencyTo,
	});
	frequencyConditions.push(
		eq(posts.status, "published"),
		sql`${posts.publishedAt} IS NOT NULL`,
	);
	const frequencyWhere = and(...frequencyConditions);

	const weekRows = await db.execute<{
		post_count: string | number;
		total_engagement: string | number | null;
		total_impressions: string | number | null;
	}>(sql`
		WITH latest AS (
			SELECT DISTINCT ON (${postAnalytics.postTargetId})
				${postAnalytics.postTargetId} AS post_target_id,
				${postTargets.postId} AS post_id,
				${posts.publishedAt} AS published_at,
				${postAnalytics.impressions} AS impressions,
				${postAnalytics.likes} AS likes,
				${postAnalytics.comments} AS comments,
				${postAnalytics.shares} AS shares
			FROM ${postAnalytics}
			JOIN ${postTargets} ON ${postTargets.id} = ${postAnalytics.postTargetId}
			JOIN ${posts} ON ${posts.id} = ${postTargets.postId}
			WHERE ${frequencyWhere}
			ORDER BY ${postAnalytics.postTargetId}, ${postAnalytics.collectedAt} DESC, ${postAnalytics.id} DESC
		),
		posts_in_scope AS (
			SELECT DISTINCT
				${posts.id} AS post_id,
				${posts.publishedAt} AS published_at
			FROM ${posts}
			JOIN ${postTargets} ON ${postTargets.postId} = ${posts.id}
			WHERE ${frequencyWhere}
		),
		weekly AS (
			SELECT
				date_trunc('week', pis.published_at) AS week,
				COUNT(DISTINCT pis.post_id) AS post_count,
				COALESCE(SUM(l.likes + l.comments + l.shares), 0) AS total_engagement,
				COALESCE(SUM(l.impressions), 0) AS total_impressions
			FROM posts_in_scope pis
			LEFT JOIN latest l ON l.post_id = pis.post_id
			GROUP BY date_trunc('week', pis.published_at)
		)
		SELECT post_count, total_engagement, total_impressions FROM weekly
	`);

	type WeekRow = {
		post_count: string | number;
		total_engagement: string | number | null;
		total_impressions: string | number | null;
	};
	const weekResult = weekRows as { rows?: WeekRow[] } & ArrayLike<WeekRow>;
	const rawWeeks: WeekRow[] = weekResult.rows ?? Array.from(weekResult);

	if (rawWeeks.length === 0) {
		return c.json({ data: [], optimal_frequency: 0 }, 200);
	}

	const toNum = (v: string | number | null | undefined) =>
		v == null ? 0 : typeof v === "number" ? v : Number(v);

	const weekData = rawWeeks.map((w) => ({
		count: toNum(w.post_count),
		totalEngagement: toNum(w.total_engagement),
		totalImpressions: toNum(w.total_impressions),
	}));

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
			val.weekCount > 0 ? Math.round(val.totalImpressions / val.weekCount) : 0,
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
	const account = await requireLegacyAnalyticsAccount(
		c,
		query.account_id,
		"youtube",
	);
	if (account instanceof Response) return account as never;

	const startDate = query.from_date
		? new Date(query.from_date)
		: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	const endDate = query.to_date ? new Date(query.to_date) : new Date();

	const targetConditions = legacyAnalyticsConditions({
		organizationId: orgId,
		workspaceScope: c.get("workspaceScope"),
		accountId: query.account_id,
		platform: "youtube",
		fromDate: startDate,
		toDate: endDate,
	});

	// Compute latest-per-target daily deltas and their cumulative total entirely
	// in SQL. This removes the old silent 1,000-target cap and keeps the Worker
	// response bounded to at most one row per validated day.
	const viewRows = await db.execute<{
		date: string;
		views: string | number | null;
	}>(sql`
		WITH daily_latest AS (
			SELECT DISTINCT ON (
				${postAnalytics.postTargetId},
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date
			)
				${postAnalytics.postTargetId} AS post_target_id,
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date AS day,
				COALESCE(${postAnalytics.views}, 0)::bigint AS views
			FROM ${postAnalytics}
			INNER JOIN ${postTargets}
				ON ${postTargets.id} = ${postAnalytics.postTargetId}
			INNER JOIN ${posts} ON ${posts.id} = ${postTargets.postId}
			WHERE ${and(...targetConditions)}
				AND ${postAnalytics.collectedAt} >= ${startDate}
				AND ${postAnalytics.collectedAt} <= ${endDate}
			ORDER BY
				${postAnalytics.postTargetId},
				(${postAnalytics.collectedAt} AT TIME ZONE 'UTC')::date,
				${postAnalytics.collectedAt} DESC,
				${postAnalytics.id} DESC
		),
		deltas AS (
			SELECT
				post_target_id,
				day,
				views - COALESCE(
					LAG(views) OVER (PARTITION BY post_target_id ORDER BY day),
					0
				) AS views_delta
			FROM daily_latest
		),
		daily_deltas AS (
			SELECT
				day,
				SUM(views_delta) AS views_delta
			FROM deltas
			GROUP BY day
		)
		SELECT
			to_char(day, 'YYYY-MM-DD') AS date,
			SUM(views_delta) OVER (ORDER BY day) AS views
		FROM daily_deltas
		ORDER BY day
	`);
	type ViewRow = { date: string; views: string | number | null };
	const viewResult = viewRows as { rows?: ViewRow[] } & ArrayLike<ViewRow>;
	const data = (viewResult.rows ?? Array.from(viewResult)).map((row) => ({
		date: row.date,
		views:
			row.views == null
				? 0
				: typeof row.views === "number"
					? row.views
					: Number(row.views),
		// These provider dimensions are not yet collected in post_analytics.
		watch_time_minutes: 0,
		subscribers_gained: 0,
	}));

	return c.json({ data }, 200);
});

// =============================================================================
// Platform Analytics — live data from each platform's native API
// =============================================================================

function getPlatformDateRange(fromDate?: string, toDate?: string): DateRange {
	const to = toDate || new Date().toISOString().slice(0, 10);
	const from =
		fromDate ||
		new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
		accessToken: await decryptAccountToken(
			account.accessToken,
			encryptionKey,
			account.id,
			"access_token",
		),
	};
}

/** Long retention for the stale-while-revalidate envelope (24h). */
const ANALYTICS_OVERVIEW_CACHE_RETENTION_SECONDS = 24 * 60 * 60;

interface CachedOverviewEnvelope {
	data: PlatformOverview;
	fetchedAt: number; // epoch ms
}

function overviewCacheKey(accountId: string, dateRange: DateRange): string {
	return `analytics-overview:${accountId}:${dateRange.from}:${dateRange.to}`;
}

async function getCachedPlatformOverview(
	env: Env,
	// Only waitUntil is used; narrowing keeps Hono's c.executionCtx assignable here
	// regardless of fields Cloudflare's generated runtime types add to ExecutionContext.
	executionCtx: Pick<ExecutionContext, "waitUntil">,
	account: {
		id: string;
		platform: string;
		platformAccountId: string;
		accessToken: string;
	},
	dateRange: DateRange,
	// Optional pre-read cache envelope, when the caller started the KV read
	// concurrently with its DB fetch (avoids a second KV round trip).
	prefetched?: CachedOverviewEnvelope | null,
): Promise<PlatformOverview | null> {
	const fetcher = getPlatformFetcher(account.platform);
	if (!fetcher) return null;

	const cacheKey = overviewCacheKey(account.id, dateRange);

	const refresh = async (): Promise<PlatformOverview> => {
		const fresh = await fetcher.getOverview(
			account.accessToken,
			account.platformAccountId,
			dateRange,
		);
		const envelope: CachedOverviewEnvelope = {
			data: fresh,
			fetchedAt: Date.now(),
		};
		await env.KV.put(cacheKey, JSON.stringify(envelope), {
			expirationTtl: ANALYTICS_OVERVIEW_CACHE_RETENTION_SECONDS,
		});
		return fresh;
	};

	const cached =
		prefetched !== undefined
			? prefetched
			: await env.KV.get<CachedOverviewEnvelope>(cacheKey, "json");
	if (cached?.data && typeof cached.fetchedAt === "number") {
		const ageSeconds = (Date.now() - cached.fetchedAt) / 1000;
		if (ageSeconds < ANALYTICS_OVERVIEW_CACHE_TTL_SECONDS) {
			// Fresh enough — serve directly.
			return cached.data;
		}
		// Stale-while-revalidate: serve the stale value immediately and refresh
		// in the background so the next request is warm.
		executionCtx.waitUntil(refresh().catch(() => undefined));
		return cached.data;
	}

	// Cold miss — must fetch synchronously.
	return refresh();
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
	const channelResults = await mapConcurrently(
		rawAccounts,
		8,
		async (account) => {
			const hasAnalytics = PLATFORMS_WITH_ANALYTICS.includes(account.platform);
			let needsReconnect =
				hasAnalytics && !hasAnalyticsScopes(account.platform, account.scopes);

			let followers: number | null = null;
			let impressions: number | null = null;
			let engagementRate: number | null = null;
			let engagement = 0;

			if (hasAnalytics && !needsReconnect && account.accessToken) {
				try {
					const accessToken = await decryptAccountToken(
						account.accessToken,
						c.env.ENCRYPTION_KEY,
						account.id,
						"access_token",
					);
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
					if (
						err instanceof PlatformAnalyticsError &&
						(err.code === "TOKEN_EXPIRED" || err.code === "MISSING_PERMISSIONS")
					) {
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
		},
	);

	const channels = channelResults.map((result) => result.channel);
	const totalAudience = channelResults.reduce(
		(sum, result) => sum + result.followers,
		0,
	);
	const totalImpressions = channelResults.reduce(
		(sum, result) => sum + result.impressions,
		0,
	);
	const totalEngagement = channelResults.reduce(
		(sum, result) => sum + result.engagement,
		0,
	);

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

	// The overview cache key needs only account_id + date range, so start the KV
	// read concurrently with the DB account fetch instead of strictly after it.
	// All ownership/scope checks below still run on the DB row before any cached
	// value is returned, so this cannot leak analytics across tenants.
	const dateRange = getPlatformDateRange(query.from_date, query.to_date);
	const cachedPromise = c.env.KV.get<CachedOverviewEnvelope>(
		overviewCacheKey(query.account_id, dateRange),
		"json",
	);

	const account = await getAccountWithToken(
		db,
		query.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
	);
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

	try {
		const prefetched = await cachedPromise;
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
			prefetched,
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
			const status =
				err.code === "TOKEN_EXPIRED"
					? 401
					: err.code === "MISSING_PERMISSIONS"
						? 403
						: 502;
			return c.json(
				{ error: { code: err.code, message: err.message } },
				status,
			);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformPosts, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(
		db,
		query.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
	);
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

	// Short-TTL KV cache: getPostMetrics fans out into N per-media insights
	// calls (one per post), so an uncached request can block for seconds.
	// Cache the result per account + date range + limit, mirroring the
	// overview cache. Ownership/scope checks above run on every request.
	const cacheKey = `analytics-posts:${query.account_id}:${dateRange.from}:${dateRange.to}:${query.limit}`;
	const cached = await c.env.KV.get<PlatformPostMetrics[]>(cacheKey, "json");
	if (cached) {
		return c.json({ data: cached }, 200);
	}

	try {
		const platformPosts = await fetcher.getPostMetrics(
			account.accessToken,
			account.platformAccountId,
			dateRange,
			query.limit,
		);
		// Don't cache an empty result: some fetchers swallow transient errors
		// (rate limit / 5xx) and return [], which would otherwise pin "no posts"
		// for the full TTL. Only persist a non-empty success.
		if (platformPosts.length > 0) {
			c.executionCtx.waitUntil(
				c.env.KV.put(cacheKey, JSON.stringify(platformPosts), {
					expirationTtl: ANALYTICS_POSTS_CACHE_TTL_SECONDS,
				}),
			);
		}
		return c.json({ data: platformPosts }, 200);
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) {
			const status =
				err.code === "TOKEN_EXPIRED"
					? 401
					: err.code === "MISSING_PERMISSIONS"
						? 403
						: 502;
			return c.json(
				{ error: { code: err.code, message: err.message } },
				status,
			);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformAudience, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(
		db,
		query.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
	);
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
			const status =
				err.code === "TOKEN_EXPIRED"
					? 401
					: err.code === "MISSING_PERMISSIONS"
						? 403
						: 502;
			return c.json(
				{ error: { code: err.code, message: err.message } },
				status,
			);
		}
		throw err;
	}
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getPlatformDaily, async (c) => {
	const orgId = c.get("orgId");
	const query = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccountWithToken(
		db,
		query.account_id,
		orgId,
		c.env.ENCRYPTION_KEY,
	);
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
			const status =
				err.code === "TOKEN_EXPIRED"
					? 401
					: err.code === "MISSING_PERMISSIONS"
						? 403
						: 502;
			return c.json(
				{ error: { code: err.code, message: err.message } },
				status,
			);
		}
		throw err;
	}
});

export default app;
