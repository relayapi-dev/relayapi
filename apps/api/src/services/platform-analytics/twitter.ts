import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const BASE_URL = "https://api.x.com/2";

interface TwitterPublicMetrics {
	impression_count: number;
	like_count: number;
	retweet_count: number;
	reply_count: number;
	quote_count: number;
	bookmark_count: number;
}

interface TwitterTweet {
	id: string;
	text: string;
	created_at: string;
	public_metrics: TwitterPublicMetrics;
}

interface TwitterUserResponse {
	data: {
		id: string;
		public_metrics: {
			followers_count: number;
			following_count: number;
			tweet_count: number;
			listed_count: number;
		};
	};
}

interface TwitterTweetsResponse {
	data?: TwitterTweet[];
	meta?: {
		next_token?: string;
		result_count: number;
	};
}

interface TwitterErrorResponse {
	errors?: { message: string }[];
	detail?: string;
}

function authHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
	};
}

function handleApiError(
	context: string,
	body: TwitterErrorResponse,
): void {
	if (body.errors) {
		console.error(
			`[twitter-analytics] ${context}:`,
			body.errors.map((e) => e.message).join(", "),
		);
	} else if (body.detail) {
		console.error(`[twitter-analytics] ${context}:`, body.detail);
	}
}

async function fetchAllTweetsInRange(
	accessToken: string,
	userId: string,
	dateRange: DateRange,
	maxResults = 100,
): Promise<TwitterTweet[]> {
	const allTweets: TwitterTweet[] = [];
	let paginationToken: string | undefined;
	// Cap at 10 pages (1000 tweets) to avoid excessive API usage
	const maxPages = 10;
	let page = 0;

	do {
		const params = new URLSearchParams({
			"tweet.fields": "public_metrics,created_at",
			max_results: String(Math.min(maxResults, 100)),
			start_time: `${dateRange.from}T00:00:00Z`,
			end_time: `${dateRange.to}T23:59:59Z`,
		});
		if (paginationToken) {
			params.set("pagination_token", paginationToken);
		}

		const res = await fetch(
			`${BASE_URL}/users/${userId}/tweets?${params.toString()}`,
			{ headers: authHeaders(accessToken) },
		);

		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as TwitterErrorResponse;
			handleApiError("fetchAllTweetsInRange", body);
			break;
		}

		const json = (await res.json()) as TwitterTweetsResponse;
		if (json.data) {
			allTweets.push(...json.data);
		}

		paginationToken = json.meta?.next_token;
		page++;
	} while (paginationToken && page < maxPages);

	return allTweets;
}

export const twitterAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		// Fetch user profile metrics
		let followers: number | null = null;
		let following: number | null = null;
		let tweetCount: number | null = null;
		let listedCount: number | null = null;

		try {
			const userRes = await fetch(
				`${BASE_URL}/users/${platformAccountId}?user.fields=public_metrics`,
				{ headers: authHeaders(accessToken) },
			);

			if (userRes.ok) {
				const userJson = (await userRes.json()) as TwitterUserResponse;
				const metrics = userJson.data.public_metrics;
				followers = metrics.followers_count;
				following = metrics.following_count;
				tweetCount = metrics.tweet_count;
				listedCount = metrics.listed_count;
			} else {
				const body = (await userRes.json().catch(() => ({}))) as TwitterErrorResponse;
				handleApiError("getOverview/user", body);
			}
		} catch (err) {
			console.error("[twitter-analytics] getOverview/user fetch error:", err);
		}

		// Fetch recent tweets in the date range
		let impressions = 0;
		let likes = 0;
		let retweets = 0;
		let replies = 0;
		let quotes = 0;
		let postsCount = 0;

		try {
			const tweets = await fetchAllTweetsInRange(
				accessToken,
				platformAccountId,
				dateRange,
			);
			postsCount = tweets.length;

			for (const tweet of tweets) {
				const m = tweet.public_metrics;
				impressions += m.impression_count;
				likes += m.like_count;
				retweets += m.retweet_count;
				replies += m.reply_count;
				quotes += m.quote_count;
			}
		} catch (err) {
			console.error("[twitter-analytics] getOverview/tweets fetch error:", err);
		}

		const engagement = likes + retweets + replies + quotes;
		const engagementRate =
			impressions > 0 ? (engagement / impressions) * 100 : null;

		return {
			followers,
			follower_change: null,
			impressions,
			impression_change: null,
			engagement,
			engagement_change: null,
			engagement_rate: engagementRate,
			posts_count: postsCount,
			reach: null,
			reach_change: null,
			platform_specific: {
				following: following,
				tweet_count: tweetCount,
				listed_count: listedCount,
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
			const params = new URLSearchParams({
				"tweet.fields": "public_metrics,created_at,text",
				max_results: String(Math.min(limit, 100)),
				start_time: `${dateRange.from}T00:00:00Z`,
				end_time: `${dateRange.to}T23:59:59Z`,
			});

			const res = await fetch(
				`${BASE_URL}/users/${platformAccountId}/tweets?${params.toString()}`,
				{ headers: authHeaders(accessToken) },
			);

			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as TwitterErrorResponse;
				handleApiError("getPostMetrics", body);
				return [];
			}

			const json = (await res.json()) as TwitterTweetsResponse;
			if (!json.data) {
				return [];
			}

			return json.data.map((tweet) => {
				const m = tweet.public_metrics;
				const totalEngagement = m.like_count + m.retweet_count + m.reply_count;
				const engagementRate =
					m.impression_count > 0
						? (totalEngagement / m.impression_count) * 100
						: 0;

				return {
					platform_post_id: tweet.id,
					content: tweet.text,
					published_at: tweet.created_at,
					media_url: null,
					media_type: null,
					impressions: m.impression_count,
					reach: 0,
					likes: m.like_count,
					comments: m.reply_count,
					shares: m.retweet_count,
					saves: m.bookmark_count,
					clicks: 0,
					engagement_rate: engagementRate,
					platform_url: `https://x.com/i/status/${tweet.id}`,
				};
			});
		} catch (err) {
			console.error("[twitter-analytics] getPostMetrics fetch error:", err);
			return [];
		}
	},

	async getAudience(
		_accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		// Twitter API v2 does not provide audience demographics
		return null;
	},

	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		try {
			const tweets = await fetchAllTweetsInRange(
				accessToken,
				platformAccountId,
				dateRange,
			);

			// Group tweets by date
			const dailyMap = new Map<
				string,
				{ impressions: number; engagement: number }
			>();

			for (const tweet of tweets) {
				const date = tweet.created_at.split("T")[0] ?? tweet.created_at;
				const existing = dailyMap.get(date) || {
					impressions: 0,
					engagement: 0,
				};
				const m = tweet.public_metrics;
				existing.impressions += m.impression_count;
				existing.engagement +=
					m.like_count + m.retweet_count + m.reply_count + m.quote_count;
				dailyMap.set(date, existing);
			}

			// Build array for all dates in range, filling in zeros for days with no tweets
			const result: DailyMetricPoint[] = [];
			const startDate = new Date(`${dateRange.from}T00:00:00Z`);
			const endDate = new Date(`${dateRange.to}T00:00:00Z`);

			for (
				let d = new Date(startDate);
				d <= endDate;
				d.setUTCDate(d.getUTCDate() + 1)
			) {
				const dateStr = d.toISOString().split("T")[0] as string;
				const dayData = dailyMap.get(dateStr);

				result.push({
					date: dateStr,
					impressions: dayData?.impressions ?? 0,
					engagement: dayData?.engagement ?? 0,
					reach: 0,
					followers: 0,
				});
			}

			return result;
		} catch (err) {
			console.error("[twitter-analytics] getDailyMetrics fetch error:", err);
			return [];
		}
	},
};
