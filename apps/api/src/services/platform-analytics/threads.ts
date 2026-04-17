import { GRAPH_BASE } from "../../config/api-versions";
import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const BASE_URL = GRAPH_BASE.threads;

function toUnix(dateStr: string): number {
	return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

function pctChange(current: number, previous: number): number | null {
	if (previous === 0) return current > 0 ? 100 : null;
	return Math.round(((current - previous) / previous) * 10000) / 100;
}

function previousPeriod(dateRange: DateRange): DateRange {
	const fromMs = new Date(`${dateRange.from}T00:00:00Z`).getTime();
	const toMs = new Date(`${dateRange.to}T00:00:00Z`).getTime();
	const durationMs = toMs - fromMs;
	const prevTo = new Date(fromMs - 86_400_000);
	const prevFrom = new Date(prevTo.getTime() - durationMs);
	return {
		from: prevFrom.toISOString().slice(0, 10),
		to: prevTo.toISOString().slice(0, 10),
	};
}

interface ThreadsInsightValue {
	value: number;
	end_time?: string;
}

interface ThreadsInsightMetric {
	name: string;
	period?: string;
	title?: string;
	values?: ThreadsInsightValue[];
	total_value?: { value: number };
}

interface ThreadsInsightsResponse {
	data: ThreadsInsightMetric[];
}

interface ThreadsPost {
	id: string;
	text?: string;
	timestamp?: string;
	media_type?: string;
	media_url?: string;
	permalink?: string;
}

interface ThreadsPostsResponse {
	data: ThreadsPost[];
}

interface ThreadsDemographicResult {
	dimension_values: string[];
	value: number;
}

interface ThreadsDemographicBreakdown {
	results: ThreadsDemographicResult[];
}

interface ThreadsDemographicMetric {
	name: string;
	total_value?: {
		breakdowns?: ThreadsDemographicBreakdown[];
	};
}

interface ThreadsDemographicsResponse {
	data: ThreadsDemographicMetric[];
}

async function threadsFetch<T = unknown>(
	path: string,
	accessToken: string,
): Promise<T | null> {
	const separator = path.includes("?") ? "&" : "?";
	const url = `${BASE_URL}${path}${separator}access_token=${accessToken}`;

	try {
		const res = await fetch(url);
		if (!res.ok) {
			console.error(
				`[threads-analytics] API error ${res.status} for ${path}: ${await res.text()}`,
			);
			return null;
		}
		return (await res.json()) as T;
	} catch (err) {
		console.error(`[threads-analytics] Fetch failed for ${path}:`, err);
		return null;
	}
}

function getMetricTotal(
	data: ThreadsInsightMetric[] | undefined,
	metricName: string,
): number {
	if (!data) return 0;
	const metric = data.find((m) => m.name === metricName);
	if (!metric) return 0;

	if (metric.total_value?.value != null) return metric.total_value.value;

	if (metric.values) {
		return metric.values.reduce((sum, v) => sum + (v.value ?? 0), 0);
	}

	return 0;
}

async function fetchInsightsSums(
	userId: string,
	accessToken: string,
	dateRange: DateRange,
): Promise<{ views: number; likes: number; replies: number; reposts: number; quotes: number }> {
	const since = toUnix(dateRange.from);
	const until = toUnix(dateRange.to);

	const data = await threadsFetch<ThreadsInsightsResponse>(
		`/${userId}/threads_insights?metric=views,likes,replies,reposts,quotes&since=${since}&until=${until}`,
		accessToken,
	);

	const items = data?.data ?? [];
	return {
		views: getMetricTotal(items, "views"),
		likes: getMetricTotal(items, "likes"),
		replies: getMetricTotal(items, "replies"),
		reposts: getMetricTotal(items, "reposts"),
		quotes: getMetricTotal(items, "quotes"),
	};
}

export const threadsAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		const since = toUnix(dateRange.from);
		const until = toUnix(dateRange.to);

		const insightsData = await threadsFetch<ThreadsInsightsResponse>(
			`/${platformAccountId}/threads_insights?metric=views,likes,replies,reposts,quotes,followers_count&since=${since}&until=${until}`,
			accessToken,
		);

		const items = insightsData?.data ?? [];

		const views = getMetricTotal(items, "views");
		const likes = getMetricTotal(items, "likes");
		const replies = getMetricTotal(items, "replies");
		const reposts = getMetricTotal(items, "reposts");
		const quotes = getMetricTotal(items, "quotes");
		const followersCount = getMetricTotal(items, "followers_count");

		const engagement = likes + replies + reposts + quotes;
		const engagementRate = views > 0 ? Math.round((engagement / views) * 10000) / 100 : null;

		const prev = previousPeriod(dateRange);
		const prevSums = await fetchInsightsSums(platformAccountId, accessToken, prev);
		const prevViews = prevSums.views;
		const prevEngagement = prevSums.likes + prevSums.replies + prevSums.reposts + prevSums.quotes;

		return {
			followers: followersCount || null,
			follower_change: null,
			impressions: views || null,
			impression_change: pctChange(views, prevViews),
			engagement: engagement || null,
			engagement_change: pctChange(engagement, prevEngagement),
			engagement_rate: engagementRate,
			posts_count: null,
			reach: views || null,
			reach_change: pctChange(views, prevViews),
			platform_specific: {
				likes,
				replies,
				reposts,
				quotes,
			},
		};
	},

	async getPostMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
		limit = 25,
	): Promise<PlatformPostMetrics[]> {
		try {
			const since = toUnix(dateRange.from);
			const until = toUnix(dateRange.to);

			const postsData = await threadsFetch<ThreadsPostsResponse>(
				`/${platformAccountId}/threads?fields=id,text,timestamp,media_type,media_url,permalink&since=${since}&until=${until}&limit=${limit}`,
				accessToken,
			);

			const posts = postsData?.data ?? [];
			if (posts.length === 0) return [];

			const results: PlatformPostMetrics[] = [];

			for (const post of posts) {
				const insightsData = await threadsFetch<ThreadsInsightsResponse>(
					`/${post.id}/insights?metric=views,likes,replies,reposts,quotes`,
					accessToken,
				);

				const metrics = insightsData?.data ?? [];
				const postViews = getMetricTotal(metrics, "views");
				const postLikes = getMetricTotal(metrics, "likes");
				const postReplies = getMetricTotal(metrics, "replies");
				const postReposts = getMetricTotal(metrics, "reposts");
				const postQuotes = getMetricTotal(metrics, "quotes");

				const totalEngagement = postLikes + postReplies + postReposts + postQuotes;
				const engagementRate = postViews > 0 ? (totalEngagement / postViews) * 100 : 0;

				results.push({
					platform_post_id: post.id,
					content: post.text ?? null,
					published_at: post.timestamp ?? "",
					media_url: post.media_url ?? null,
					media_type: post.media_type ?? null,
					impressions: postViews,
					reach: postViews,
					likes: postLikes,
					comments: postReplies,
					shares: postReposts,
					saves: 0,
					clicks: 0,
					engagement_rate: engagementRate,
					platform_url: post.permalink ?? null,
				});
			}

			return results;
		} catch (err) {
			console.error("[threads-analytics] getPostMetrics error:", err);
			return [];
		}
	},

	async getAudience(
		accessToken: string,
		platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		try {
			const [cityData, countryData, ageGenderData] = await Promise.all([
				threadsFetch<ThreadsDemographicsResponse>(
					`/${platformAccountId}/threads_insights?metric=follower_demographics&period=lifetime&breakdown=city`,
					accessToken,
				),
				threadsFetch<ThreadsDemographicsResponse>(
					`/${platformAccountId}/threads_insights?metric=follower_demographics&period=lifetime&breakdown=country`,
					accessToken,
				),
				threadsFetch<ThreadsDemographicsResponse>(
					`/${platformAccountId}/threads_insights?metric=follower_demographics&period=lifetime&breakdown=age,gender`,
					accessToken,
				),
			]);

			const cityResults =
				cityData?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
			const topCities = cityResults
				.map((r) => ({ name: r.dimension_values?.[0] ?? "Unknown", count: r.value ?? 0 }))
				.sort((a, b) => b.count - a.count)
				.slice(0, 20);

			const countryResults =
				countryData?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
			const topCountries = countryResults
				.map((r) => ({
					code: r.dimension_values?.[0] ?? "XX",
					name: r.dimension_values?.[0] ?? "XX",
					count: r.value ?? 0,
				}))
				.sort((a, b) => b.count - a.count)
				.slice(0, 20);

			const ageGenderResults =
				ageGenderData?.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
			const ageGenderMap: Record<string, { male: number; female: number; other: number }> = {};

			for (const r of ageGenderResults) {
				const ageRange = r.dimension_values?.[0] ?? "unknown";
				const gender = (r.dimension_values?.[1] ?? "").toUpperCase();
				const value = r.value ?? 0;

				if (!ageGenderMap[ageRange]) {
					ageGenderMap[ageRange] = { male: 0, female: 0, other: 0 };
				}

				if (gender === "M" || gender === "MALE") {
					ageGenderMap[ageRange].male += value;
				} else if (gender === "F" || gender === "FEMALE") {
					ageGenderMap[ageRange].female += value;
				} else {
					ageGenderMap[ageRange].other += value;
				}
			}

			const ageGender = Object.entries(ageGenderMap)
				.map(([age_range, counts]) => ({ age_range, ...counts }))
				.sort((a, b) => b.male + b.female + b.other - (a.male + a.female + a.other))
				.slice(0, 20);

			return {
				top_cities: topCities,
				top_countries: topCountries,
				age_gender: ageGender,
			};
		} catch (err) {
			console.error("[threads-analytics] getAudience error:", err);
			return null;
		}
	},

	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		try {
			const since = toUnix(dateRange.from);
			const until = toUnix(dateRange.to);

			const data = await threadsFetch<ThreadsInsightsResponse>(
				`/${platformAccountId}/threads_insights?metric=views,likes,replies,reposts,quotes&since=${since}&until=${until}`,
				accessToken,
			);

			const items = data?.data ?? [];
			if (items.length === 0) return [];

			const viewsMetric = items.find((m) => m.name === "views");
			const likesMetric = items.find((m) => m.name === "likes");
			const repliesMetric = items.find((m) => m.name === "replies");
			const repostsMetric = items.find((m) => m.name === "reposts");
			const quotesMetric = items.find((m) => m.name === "quotes");

			const dateMap: Record<string, { impressions: number; engagement: number }> = {};

			for (const v of viewsMetric?.values ?? []) {
				const date = v.end_time?.slice(0, 10) ?? "";
				if (!date) continue;
				if (!dateMap[date]) dateMap[date] = { impressions: 0, engagement: 0 };
				dateMap[date].impressions = v.value ?? 0;
			}

			const engagementMetrics = [likesMetric, repliesMetric, repostsMetric, quotesMetric];
			for (const metric of engagementMetrics) {
				for (const v of metric?.values ?? []) {
					const date = v.end_time?.slice(0, 10) ?? "";
					if (!date) continue;
					if (!dateMap[date]) dateMap[date] = { impressions: 0, engagement: 0 };
					dateMap[date].engagement += v.value ?? 0;
				}
			}

			return Object.entries(dateMap)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([date, vals]) => ({
					date,
					impressions: vals.impressions,
					engagement: vals.engagement,
					reach: vals.impressions,
					followers: 0,
				}));
		} catch (err) {
			console.error("[threads-analytics] getDailyMetrics error:", err);
			return [];
		}
	},
};
