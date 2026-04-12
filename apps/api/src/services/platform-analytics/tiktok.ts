import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const BASE_URL = "https://open.tiktokapis.com/v2";

function authHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
	};
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

interface TikTokUserInfo {
	data: {
		user: {
			follower_count?: number;
			following_count?: number;
			likes_count?: number;
			video_count?: number;
		};
	};
}

interface TikTokVideo {
	id: string;
	title?: string;
	view_count?: number;
	like_count?: number;
	comment_count?: number;
	share_count?: number;
	create_time?: number;
	cover_image_url?: string;
	share_url?: string;
}

interface TikTokVideoListResponse {
	data: {
		videos: TikTokVideo[];
		cursor?: number;
		has_more?: boolean;
	};
}

interface TikTokVideoQueryResponse {
	data: {
		videos: TikTokVideo[];
	};
}

async function fetchAllVideos(
	accessToken: string,
	maxCount = 100,
): Promise<TikTokVideo[]> {
	const allVideos: TikTokVideo[] = [];
	let cursor: number | undefined;
	let hasMore = true;
	const maxPages = 5;
	let page = 0;

	while (hasMore && page < maxPages) {
		try {
			const body: Record<string, unknown> = { max_count: Math.min(maxCount, 20) };
			if (cursor !== undefined) body.cursor = cursor;

			const res = await fetch(`${BASE_URL}/video/list/`, {
				method: "POST",
				headers: authHeaders(accessToken),
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				console.error(`[tiktok-analytics] video/list error ${res.status}: ${await res.text()}`);
				break;
			}

			const json = (await res.json()) as TikTokVideoListResponse;
			const videos = json.data?.videos ?? [];
			allVideos.push(...videos);

			hasMore = json.data?.has_more ?? false;
			cursor = json.data?.cursor;
			page++;
		} catch (err) {
			console.error("[tiktok-analytics] video/list fetch error:", err);
			break;
		}
	}

	return allVideos;
}

async function fetchVideoDetails(
	accessToken: string,
	videoIds: string[],
): Promise<TikTokVideo[]> {
	if (videoIds.length === 0) return [];

	try {
		const res = await fetch(
			`${BASE_URL}/video/query/?fields=id,title,view_count,like_count,comment_count,share_count,create_time,cover_image_url,share_url`,
			{
				method: "POST",
				headers: authHeaders(accessToken),
				body: JSON.stringify({ filters: { video_ids: videoIds } }),
			},
		);

		if (!res.ok) {
			console.error(`[tiktok-analytics] video/query error ${res.status}: ${await res.text()}`);
			return [];
		}

		const json = (await res.json()) as TikTokVideoQueryResponse;
		return json.data?.videos ?? [];
	} catch (err) {
		console.error("[tiktok-analytics] video/query fetch error:", err);
		return [];
	}
}

function filterVideosByDateRange(videos: TikTokVideo[], dateRange: DateRange): TikTokVideo[] {
	const fromTs = new Date(`${dateRange.from}T00:00:00Z`).getTime() / 1000;
	const toTs = new Date(`${dateRange.to}T23:59:59Z`).getTime() / 1000;

	return videos.filter((v) => {
		if (!v.create_time) return false;
		return v.create_time >= fromTs && v.create_time <= toTs;
	});
}

export const tiktokAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		let followers: number | null = null;
		let following: number | null = null;
		let totalLikes: number | null = null;
		let videoCount: number | null = null;

		try {
			const res = await fetch(
				`${BASE_URL}/user/info/?fields=follower_count,following_count,likes_count,video_count`,
				{ headers: authHeaders(accessToken) },
			);

			if (res.ok) {
				const json = (await res.json()) as TikTokUserInfo;
				const user = json.data?.user;
				followers = user?.follower_count ?? null;
				following = user?.following_count ?? null;
				totalLikes = user?.likes_count ?? null;
				videoCount = user?.video_count ?? null;
			} else {
				console.error(`[tiktok-analytics] user/info error ${res.status}: ${await res.text()}`);
			}
		} catch (err) {
			console.error("[tiktok-analytics] user/info fetch error:", err);
		}

		let views = 0;
		let likes = 0;
		let comments = 0;
		let shares = 0;
		let postsCount = 0;

		try {
			const allVideos = await fetchAllVideos(accessToken);
			const rangeVideos = filterVideosByDateRange(allVideos, dateRange);
			postsCount = rangeVideos.length;

			if (rangeVideos.length > 0) {
				const details = await fetchVideoDetails(
					accessToken,
					rangeVideos.map((v) => v.id),
				);
				for (const v of details) {
					views += v.view_count ?? 0;
					likes += v.like_count ?? 0;
					comments += v.comment_count ?? 0;
					shares += v.share_count ?? 0;
				}
			}
		} catch (err) {
			console.error("[tiktok-analytics] getOverview videos error:", err);
		}

		const engagement = likes + comments + shares;
		const engagementRate = views > 0 ? Math.round((engagement / views) * 10000) / 100 : null;

		return {
			followers,
			follower_change: null,
			impressions: views || null,
			impression_change: null,
			engagement: engagement || null,
			engagement_change: null,
			engagement_rate: engagementRate,
			posts_count: postsCount,
			reach: views || null,
			reach_change: null,
			platform_specific: {
				following,
				total_likes: totalLikes,
				video_count: videoCount,
			},
		};
	},

	async getPostMetrics(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
		limit = 25,
	): Promise<PlatformPostMetrics[]> {
		try {
			const allVideos = await fetchAllVideos(accessToken, limit);
			const rangeVideos = filterVideosByDateRange(allVideos, dateRange).slice(0, limit);

			if (rangeVideos.length === 0) return [];

			const details = await fetchVideoDetails(
				accessToken,
				rangeVideos.map((v) => v.id),
			);

			return details.map((v) => {
				const viewCount = v.view_count ?? 0;
				const likeCount = v.like_count ?? 0;
				const commentCount = v.comment_count ?? 0;
				const shareCount = v.share_count ?? 0;
				const totalEngagement = likeCount + commentCount + shareCount;
				const engagementRate = viewCount > 0 ? (totalEngagement / viewCount) * 100 : 0;

				return {
					platform_post_id: v.id,
					content: v.title ?? null,
					published_at: v.create_time
						? new Date(v.create_time * 1000).toISOString()
						: "",
					media_url: v.cover_image_url ?? null,
					media_type: "VIDEO",
					impressions: viewCount,
					reach: viewCount,
					likes: likeCount,
					comments: commentCount,
					shares: shareCount,
					saves: 0,
					clicks: 0,
					engagement_rate: engagementRate,
					platform_url: v.share_url ?? null,
				};
			});
		} catch (err) {
			console.error("[tiktok-analytics] getPostMetrics error:", err);
			return [];
		}
	},

	async getAudience(
		_accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		return null;
	},

	async getDailyMetrics(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		try {
			const allVideos = await fetchAllVideos(accessToken);
			const rangeVideos = filterVideosByDateRange(allVideos, dateRange);

			if (rangeVideos.length === 0) {
				return buildEmptyDailyPoints(dateRange);
			}

			const details = await fetchVideoDetails(
				accessToken,
				rangeVideos.map((v) => v.id),
			);

			const dailyMap = new Map<string, { impressions: number; engagement: number }>();

			for (const v of details) {
				if (!v.create_time) continue;
				const date = new Date(v.create_time * 1000).toISOString().slice(0, 10);
				const existing = dailyMap.get(date) || { impressions: 0, engagement: 0 };
				existing.impressions += v.view_count ?? 0;
				existing.engagement +=
					(v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0);
				dailyMap.set(date, existing);
			}

			const result: DailyMetricPoint[] = [];
			const startDate = new Date(`${dateRange.from}T00:00:00Z`);
			const endDate = new Date(`${dateRange.to}T00:00:00Z`);

			for (
				let d = new Date(startDate);
				d <= endDate;
				d.setUTCDate(d.getUTCDate() + 1)
			) {
				const dateStr = d.toISOString().slice(0, 10);
				const dayData = dailyMap.get(dateStr);

				result.push({
					date: dateStr,
					impressions: dayData?.impressions ?? 0,
					engagement: dayData?.engagement ?? 0,
					reach: dayData?.impressions ?? 0,
					followers: 0,
				});
			}

			return result;
		} catch (err) {
			console.error("[tiktok-analytics] getDailyMetrics error:", err);
			return [];
		}
	},
};

function buildEmptyDailyPoints(dateRange: DateRange): DailyMetricPoint[] {
	const result: DailyMetricPoint[] = [];
	const startDate = new Date(`${dateRange.from}T00:00:00Z`);
	const endDate = new Date(`${dateRange.to}T00:00:00Z`);

	for (
		let d = new Date(startDate);
		d <= endDate;
		d.setUTCDate(d.getUTCDate() + 1)
	) {
		result.push({
			date: d.toISOString().slice(0, 10),
			impressions: 0,
			engagement: 0,
			reach: 0,
			followers: 0,
		});
	}

	return result;
}
