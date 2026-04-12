import {
	PlatformAnalyticsError,
	type PlatformAnalyticsFetcher,
	type PlatformOverview,
	type PlatformPostMetrics,
	type PlatformAudienceDemographics,
	type DailyMetricPoint,
	type DateRange,
} from "./types";

const GRAPH_API_BASE = "https://graph.facebook.com/v25.0";

// ---------------------------------------------------------------------------
// Helper: classify Facebook Graph API error into PlatformAnalyticsError
// ---------------------------------------------------------------------------
function classifyFbError(
	status: number,
	fbCode: number | undefined,
	fbSubcode: number | undefined,
	message: string,
): PlatformAnalyticsError {
	// OAuthException with code 190 = expired/invalid token
	if (fbCode === 190 || status === 401) {
		return new PlatformAnalyticsError(
			"Facebook access token has expired or been revoked. Please reconnect the account.",
			"TOKEN_EXPIRED",
		);
	}
	// Permission errors
	if (status === 403 || fbCode === 200 || fbSubcode === 33) {
		return new PlatformAnalyticsError(
			"Missing required Facebook permissions. Please reconnect the account with analytics permissions.",
			"MISSING_PERMISSIONS",
		);
	}
	return new PlatformAnalyticsError(
		`Facebook API error: ${message}`,
		"API_ERROR",
	);
}

// ---------------------------------------------------------------------------
// Helper: authenticated GET against the Facebook Graph API
// ---------------------------------------------------------------------------
async function fbFetch<T = unknown>(
	path: string,
	accessToken: string,
	params: Record<string, string> = {},
): Promise<T> {
	const url = new URL(`${GRAPH_API_BASE}${path}`);
	url.searchParams.set("access_token", accessToken);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	try {
		const res = await fetch(url.toString());
		if (!res.ok) {
			const errorBody = await res.text();
			console.error(
				`[facebook-analytics] API error ${res.status} for ${path}: ${errorBody}`,
			);
			let fbError: { message?: string; code?: number; error_subcode?: number } | undefined;
			try {
				const parsed = JSON.parse(errorBody);
				fbError = parsed?.error;
			} catch { /* not JSON */ }
			throw classifyFbError(
				res.status,
				fbError?.code,
				fbError?.error_subcode,
				fbError?.message ?? `HTTP ${res.status}`,
			);
		}
		return (await res.json()) as T;
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) throw err;
		console.error(`[facebook-analytics] Network error for ${path}:`, err);
		throw new PlatformAnalyticsError(
			"Failed to reach Facebook API. Please try again later.",
			"API_ERROR",
		);
	}
}

// ---------------------------------------------------------------------------
// Graph API response shapes
// ---------------------------------------------------------------------------
interface InsightValue {
	value: number | Record<string, number>;
	end_time: string;
}

interface InsightMetric {
	name: string;
	period: string;
	values: InsightValue[];
}

interface InsightsResponse {
	data: InsightMetric[];
}

interface PagePost {
	id: string;
	message?: string;
	created_time: string;
	full_picture?: string;
	status_type?: string;
	permalink_url?: string;
}

interface PostsResponse {
	data: PagePost[];
}

interface PostInsightMetric {
	name: string;
	values: { value: number }[];
}

interface PostInsightsResponse {
	data: PostInsightMetric[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert YYYY-MM-DD to unix seconds */
function toUnix(dateStr: string): number {
	return Math.floor(new Date(dateStr).getTime() / 1000);
}

/** Sum all daily numeric values for a given metric from the insights response */
function sumMetric(insights: InsightsResponse, metricName: string): number {
	const metric = insights.data.find((m) => m.name === metricName);
	if (!metric) return 0;
	return metric.values.reduce((sum, v) => {
		const val = typeof v.value === "number" ? v.value : 0;
		return sum + val;
	}, 0);
}

/** Get the latest numeric value for a metric (useful for lifetime / total metrics) */
function latestMetricValue(
	insights: InsightsResponse,
	metricName: string,
): number {
	const metric = insights.data.find((m) => m.name === metricName);
	if (!metric || metric.values.length === 0) return 0;
	const last = metric.values[metric.values.length - 1];
	return typeof last?.value === "number" ? last.value : 0;
}

/** Calculate percentage change between two values */
function pctChange(current: number, previous: number): number | null {
	if (previous === 0) return current > 0 ? 100 : null;
	return Math.round(((current - previous) / previous) * 10000) / 100;
}

/** Compute the previous period DateRange of equal length */
function previousPeriod(dateRange: DateRange): DateRange {
	const from = new Date(dateRange.from);
	const to = new Date(dateRange.to);
	const durationMs = to.getTime() - from.getTime();
	const prevTo = new Date(from.getTime());
	const prevFrom = new Date(from.getTime() - durationMs);
	return {
		from: prevFrom.toISOString().slice(0, 10),
		to: prevTo.toISOString().slice(0, 10),
	};
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const facebookAnalytics: PlatformAnalyticsFetcher = {
	// -----------------------------------------------------------------------
	// getOverview
	// -----------------------------------------------------------------------
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		// Docs: https://developers.facebook.com/docs/graph-api/reference/page/insights/
		// page_engaged_users was deprecated — use page_post_engagements instead
		const metrics =
			"page_impressions,page_fans,page_post_engagements,page_fan_adds";

		// Fetch current period
		const current = await fbFetch<InsightsResponse>(
			`/${platformAccountId}/insights`,
			accessToken,
			{
				metric: metrics,
				period: "day",
				since: dateRange.from,
				until: dateRange.to,
			},
		);

		// Fetch previous period (same length) — non-critical, don't throw
		const prev = previousPeriod(dateRange);
		let previous: InsightsResponse | null = null;
		try {
			previous = await fbFetch<InsightsResponse>(
				`/${platformAccountId}/insights`,
				accessToken,
				{
					metric: metrics,
					period: "day",
					since: prev.from,
					until: prev.to,
				},
			);
		} catch { /* previous period is best-effort */ }

		const curImpressions = sumMetric(current, "page_impressions");
		const curEngagement = sumMetric(current, "page_post_engagements");
		const curFans = latestMetricValue(current, "page_fans");
		const curNewFans = sumMetric(current, "page_fan_adds");

		const prevImpressions = previous
			? sumMetric(previous, "page_impressions")
			: 0;
		const prevEngagement = previous
			? sumMetric(previous, "page_post_engagements")
			: 0;
		const prevFans = previous ? latestMetricValue(previous, "page_fans") : 0;

		const engagementRate =
			curImpressions > 0
				? Math.round((curEngagement / curImpressions) * 10000) / 100
				: null;

		return {
			followers: curFans || null,
			follower_change: pctChange(curFans, prevFans),
			impressions: curImpressions || null,
			impression_change: pctChange(curImpressions, prevImpressions),
			engagement: curEngagement || null,
			engagement_change: pctChange(curEngagement, prevEngagement),
			engagement_rate: engagementRate,
			posts_count: null, // Not directly available from insights
			reach: curImpressions || null, // Using impressions as reach proxy
			reach_change: pctChange(curImpressions, prevImpressions),
			platform_specific: {
				new_fans: curNewFans,
			},
		};
	},

	// -----------------------------------------------------------------------
	// getPostMetrics
	// -----------------------------------------------------------------------
	async getPostMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
		limit = 25,
	): Promise<PlatformPostMetrics[]> {
		// Use /feed instead of /published_posts — published_posts requires the
		// Page Public Content Access feature. /feed uses pages_read_engagement.
		// https://developers.facebook.com/docs/pages-api/posts
		//
		// Do NOT use since/until parameters — the /feed edge returns ranked
		// results and time-based pagination can produce empty results for
		// low-engagement pages. Instead, fetch recent posts and filter by
		// created_time in code.
		// https://developers.facebook.com/docs/graph-api/results#time
		const posts = await fbFetch<PostsResponse>(
			`/${platformAccountId}/feed`,
			accessToken,
			{
				fields:
					"id,message,created_time,full_picture,status_type,permalink_url",
				limit: String(limit),
			},
		);

		if (!posts?.data?.length) return [];

		// Filter posts by date range client-side (more reliable than since/until)
		const fromTs = toUnix(dateRange.from);
		const toTs = toUnix(dateRange.to) + 86400; // include the entire "to" day
		const filtered = posts.data.filter((p) => {
			const ts = Math.floor(new Date(p.created_time).getTime() / 1000);
			return ts >= fromTs && ts < toTs;
		});

		const results: PlatformPostMetrics[] = [];

		for (const post of filtered) {
			// Per-post insights are best-effort — don't let one failure break all posts
			let insights: PostInsightsResponse | null = null;
			try {
				insights = await fbFetch<PostInsightsResponse>(
					`/${post.id}/insights`,
					accessToken,
					{
						metric:
							"post_media_view,post_clicks,post_reactions_like_total",
					},
				);
			} catch { /* per-post insights are non-critical */ }

			let impressions = 0;
			let clicks = 0;
			let reactions = 0;

			if (insights?.data) {
				for (const m of insights.data) {
					const val = m.values?.[0]?.value ?? 0;
					switch (m.name) {
						case "post_media_view":
							impressions = val;
							break;
						case "post_clicks":
							clicks = val;
							break;
						case "post_reactions_like_total":
							reactions = val;
							break;
					}
				}
			}

			const engagementRate =
				impressions > 0
					? Math.round(((clicks + reactions) / impressions) * 10000) / 100
					: 0;

			results.push({
				platform_post_id: post.id,
				content: post.message ?? null,
				published_at: post.created_time,
				media_url: post.full_picture ?? null,
				media_type: post.status_type ?? null,
				impressions,
				reach: impressions,
				likes: reactions,
				comments: 0,
				shares: 0,
				saves: 0,
				clicks,
				engagement_rate: engagementRate,
				platform_url: post.permalink_url ?? null,
			});
		}

		return results;
	},

	// -----------------------------------------------------------------------
	// getAudience
	// -----------------------------------------------------------------------
	async getAudience(
		accessToken: string,
		platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		const insights = await fbFetch<InsightsResponse>(
			`/${platformAccountId}/insights`,
			accessToken,
			{
				// page_fans_gender_age was deprecated — removed to avoid API error
				metric: "page_fans_city,page_fans_country",
				period: "lifetime",
			},
		);

		if (!insights?.data) return null;

		// --- Cities ---
		const cityMetric = insights.data.find(
			(m) => m.name === "page_fans_city",
		);
		const cityMap =
			cityMetric?.values?.[0]?.value &&
			typeof cityMetric.values[0].value === "object"
				? (cityMetric.values[0].value as Record<string, number>)
				: {};
		const topCities = Object.entries(cityMap)
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 20);

		// --- Countries ---
		const countryMetric = insights.data.find(
			(m) => m.name === "page_fans_country",
		);
		const countryMap =
			countryMetric?.values?.[0]?.value &&
			typeof countryMetric.values[0].value === "object"
				? (countryMetric.values[0].value as Record<string, number>)
				: {};
		const topCountries = Object.entries(countryMap)
			.map(([code, count]) => ({ code, name: code, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 20);

		// --- Age / Gender ---
		const ageGenderMetric = insights.data.find(
			(m) => m.name === "page_fans_gender_age",
		);
		const ageGenderMap =
			ageGenderMetric?.values?.[0]?.value &&
			typeof ageGenderMetric.values[0].value === "object"
				? (ageGenderMetric.values[0].value as Record<string, number>)
				: {};

		// Keys look like "F.25-34", "M.18-24", "U.45-54"
		const ageGroups = new Map<
			string,
			{ male: number; female: number; other: number }
		>();
		for (const [key, count] of Object.entries(ageGenderMap)) {
			const [genderPrefix, ageRange] = key.split(".");
			if (!ageRange) continue;
			if (!ageGroups.has(ageRange)) {
				ageGroups.set(ageRange, { male: 0, female: 0, other: 0 });
			}
			const group = ageGroups.get(ageRange)!;
			switch (genderPrefix) {
				case "M":
					group.male += count;
					break;
				case "F":
					group.female += count;
					break;
				default:
					group.other += count;
					break;
			}
		}

		const ageGender = Array.from(ageGroups.entries())
			.map(([age_range, counts]) => ({ age_range, ...counts }))
			.sort((a, b) => {
				const totalA = a.male + a.female + a.other;
				const totalB = b.male + b.female + b.other;
				return totalB - totalA;
			})
			.slice(0, 20);

		return {
			top_cities: topCities,
			top_countries: topCountries,
			age_gender: ageGender,
		};
	},

	// -----------------------------------------------------------------------
	// getDailyMetrics
	// -----------------------------------------------------------------------
	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		const insights = await fbFetch<InsightsResponse>(
			`/${platformAccountId}/insights`,
			accessToken,
			{
				metric: "page_impressions,page_post_engagements,page_fans",
				period: "day",
				since: dateRange.from,
				until: dateRange.to,
			},
		);

		if (!insights?.data) return [];

		const impressionsMetric = insights.data.find(
			(m) => m.name === "page_impressions",
		);
		const engagementMetric = insights.data.find(
			(m) => m.name === "page_post_engagements",
		);
		const fansMetric = insights.data.find((m) => m.name === "page_fans");

		if (!impressionsMetric?.values) return [];

		const points: DailyMetricPoint[] = impressionsMetric.values.map(
			(v, i) => {
				const impressions =
					typeof v.value === "number" ? v.value : 0;
				const engagement =
					typeof engagementMetric?.values?.[i]?.value === "number"
						? (engagementMetric.values[i].value as number)
						: 0;
				const followers =
					typeof fansMetric?.values?.[i]?.value === "number"
						? (fansMetric.values[i].value as number)
						: 0;

				return {
					date: v.end_time.slice(0, 10),
					impressions,
					engagement,
					reach: impressions,
					followers,
				};
			},
		);

		return points;
	},
};
