import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const YT_ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2/reports";
const YT_DATA_BASE = "https://www.googleapis.com/youtube/v3";

// ---------------------------------------------------------------------------
// ISO country code to name mapping (top countries)
// ---------------------------------------------------------------------------
const COUNTRY_NAMES: Record<string, string> = {
	US: "United States",
	GB: "United Kingdom",
	CA: "Canada",
	AU: "Australia",
	DE: "Germany",
	FR: "France",
	BR: "Brazil",
	IN: "India",
	JP: "Japan",
	KR: "South Korea",
	MX: "Mexico",
	IT: "Italy",
	ES: "Spain",
	NL: "Netherlands",
	SE: "Sweden",
	NO: "Norway",
	DK: "Denmark",
	FI: "Finland",
	PL: "Poland",
	RU: "Russia",
	TR: "Turkey",
	AR: "Argentina",
	CO: "Colombia",
	CL: "Chile",
	PE: "Peru",
	ID: "Indonesia",
	TH: "Thailand",
	PH: "Philippines",
	VN: "Vietnam",
	MY: "Malaysia",
	SG: "Singapore",
	TW: "Taiwan",
	HK: "Hong Kong",
	ZA: "South Africa",
	NG: "Nigeria",
	EG: "Egypt",
	SA: "Saudi Arabia",
	AE: "United Arab Emirates",
	PK: "Pakistan",
	BD: "Bangladesh",
	PT: "Portugal",
	IE: "Ireland",
	NZ: "New Zealand",
	AT: "Austria",
	CH: "Switzerland",
	BE: "Belgium",
	CZ: "Czech Republic",
	RO: "Romania",
	HU: "Hungary",
	GR: "Greece",
	IL: "Israel",
	UA: "Ukraine",
};

// ---------------------------------------------------------------------------
// YouTube Analytics API response shapes
// ---------------------------------------------------------------------------
interface YTAnalyticsResponse {
	kind: string;
	columnHeaders: { name: string; columnType: string; dataType: string }[];
	rows?: (string | number)[][];
}

interface YTChannelResponse {
	items?: {
		id: string;
		statistics: {
			subscriberCount: string;
			viewCount: string;
			videoCount: string;
		};
	}[];
}

interface YTVideoSnippet {
	title: string;
	publishedAt: string;
	thumbnails: {
		medium?: { url: string };
		default?: { url: string };
	};
}

interface YTVideosResponse {
	items?: {
		id: string;
		snippet: YTVideoSnippet;
	}[];
}

interface YTErrorResponse {
	error?: {
		errors: { message: string; domain: string; reason: string }[];
		code: number;
		message: string;
	};
}

// ---------------------------------------------------------------------------
// Helper: authenticated GET against the YouTube Analytics API
// ---------------------------------------------------------------------------
async function ytAnalyticsFetch(
	accessToken: string,
	params: Record<string, string>,
): Promise<YTAnalyticsResponse | null> {
	const url = new URL(YT_ANALYTICS_BASE);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	try {
		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) {
			const errorBody = await res.text();
			console.error(
				`[youtube-analytics] Analytics API error ${res.status}: ${errorBody}`,
			);
			return null;
		}
		return (await res.json()) as YTAnalyticsResponse;
	} catch (err) {
		console.error("[youtube-analytics] Network error (analytics):", err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Helper: authenticated GET against the YouTube Data API v3
// ---------------------------------------------------------------------------
async function ytDataFetch<T = unknown>(
	path: string,
	accessToken: string,
	params: Record<string, string> = {},
): Promise<T | null> {
	const url = new URL(`${YT_DATA_BASE}${path}`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	try {
		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!res.ok) {
			const errorBody = await res.text();
			console.error(
				`[youtube-analytics] Data API error ${res.status} for ${path}: ${errorBody}`,
			);
			return null;
		}
		return (await res.json()) as T;
	} catch (err) {
		console.error(
			`[youtube-analytics] Network error (data) for ${path}:`,
			err,
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get column index by name from the analytics response */
function colIndex(
	response: YTAnalyticsResponse,
	columnName: string,
): number {
	return response.columnHeaders.findIndex((h) => h.name === columnName);
}

/** Get a numeric value from a row at a given column index */
function numVal(row: (string | number)[], index: number): number {
	if (index < 0 || index >= row.length) return 0;
	const v = row[index];
	return typeof v === "number" ? v : Number(v) || 0;
}

/** Get a string value from a row at a given column index */
function strVal(row: (string | number)[], index: number): string {
	if (index < 0 || index >= row.length) return "";
	return String(row[index]);
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

/** Map an ISO country code to a human-readable name */
function countryName(code: string): string {
	return COUNTRY_NAMES[code.toUpperCase()] || code;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const youtubeAnalytics: PlatformAnalyticsFetcher = {
	// -----------------------------------------------------------------------
	// getOverview
	// -----------------------------------------------------------------------
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		// Fetch current period analytics
		const current = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate: dateRange.from,
			endDate: dateRange.to,
			metrics:
				"views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares",
		});

		// Fetch previous period for comparison
		const prev = previousPeriod(dateRange);
		const previous = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate: prev.from,
			endDate: prev.to,
			metrics:
				"views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares",
		});

		// Get current subscriber count from Data API
		const channelData = await ytDataFetch<YTChannelResponse>(
			"/channels",
			accessToken,
			{ part: "statistics", id: platformAccountId },
		);

		const subscribers = channelData?.items?.[0]?.statistics?.subscriberCount
			? Number(channelData.items[0].statistics.subscriberCount)
			: null;

		// Extract current period metrics
		let curViews = 0;
		let curWatchTime = 0;
		let curSubsGained = 0;
		let curSubsLost = 0;
		let curLikes = 0;
		let curComments = 0;
		let curShares = 0;

		if (current?.rows?.length) {
			const row = current.rows[0] ?? [];
			curViews = numVal(row, colIndex(current, "views"));
			curWatchTime = numVal(
				row,
				colIndex(current, "estimatedMinutesWatched"),
			);
			curSubsGained = numVal(row, colIndex(current, "subscribersGained"));
			curSubsLost = numVal(row, colIndex(current, "subscribersLost"));
			curLikes = numVal(row, colIndex(current, "likes"));
			curComments = numVal(row, colIndex(current, "comments"));
			curShares = numVal(row, colIndex(current, "shares"));
		}

		// Extract previous period metrics
		let prevViews = 0;
		let prevLikes = 0;
		let prevComments = 0;
		let prevShares = 0;
		let prevSubsGained = 0;
		let prevSubsLost = 0;

		if (previous?.rows?.length) {
			const row = previous.rows[0] ?? [];
			prevViews = numVal(row, colIndex(previous, "views"));
			prevLikes = numVal(row, colIndex(previous, "likes"));
			prevComments = numVal(row, colIndex(previous, "comments"));
			prevShares = numVal(row, colIndex(previous, "shares"));
			prevSubsGained = numVal(
				row,
				colIndex(previous, "subscribersGained"),
			);
			prevSubsLost = numVal(row, colIndex(previous, "subscribersLost"));
		}

		const curEngagement = curLikes + curComments + curShares;
		const prevEngagement = prevLikes + prevComments + prevShares;

		const engagementRate =
			curViews > 0
				? Math.round((curEngagement / curViews) * 10000) / 100
				: null;

		const curNetSubs = curSubsGained - curSubsLost;
		const prevNetSubs = prevSubsGained - prevSubsLost;

		return {
			followers: subscribers,
			follower_change: pctChange(curNetSubs, prevNetSubs),
			impressions: curViews || null,
			impression_change: pctChange(curViews, prevViews),
			engagement: curEngagement || null,
			engagement_change: pctChange(curEngagement, prevEngagement),
			engagement_rate: engagementRate,
			posts_count: null,
			reach: curViews || null,
			reach_change: pctChange(curViews, prevViews),
			platform_specific: {
				watch_time_minutes: curWatchTime,
				subscribers_gained: curSubsGained,
				subscribers_lost: curSubsLost,
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
		// Fetch analytics with video dimension
		const analytics = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate: dateRange.from,
			endDate: dateRange.to,
			dimensions: "video",
			metrics:
				"views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration",
			sort: "-views",
			maxResults: String(limit),
		});

		if (!analytics?.rows?.length) return [];

		// Collect video IDs for the Data API lookup
		const videoColIdx = colIndex(analytics, "video");
		const videoIds = analytics.rows.map((row) =>
			strVal(row, videoColIdx),
		);

		// Fetch video details (snippet) in batches of 50
		const snippetMap = new Map<string, YTVideoSnippet>();
		for (let i = 0; i < videoIds.length; i += 50) {
			const batch = videoIds.slice(i, i + 50);
			const videosData = await ytDataFetch<YTVideosResponse>(
				"/videos",
				accessToken,
				{ part: "snippet", id: batch.join(",") },
			);
			if (videosData?.items) {
				for (const item of videosData.items) {
					snippetMap.set(item.id, item.snippet);
				}
			}
		}

		// Build post metrics
		const viewsIdx = colIndex(analytics, "views");
		const likesIdx = colIndex(analytics, "likes");
		const commentsIdx = colIndex(analytics, "comments");
		const sharesIdx = colIndex(analytics, "shares");
		const watchTimeIdx = colIndex(
			analytics,
			"estimatedMinutesWatched",
		);
		const avgDurationIdx = colIndex(analytics, "averageViewDuration");

		const results: PlatformPostMetrics[] = [];

		for (const row of analytics.rows) {
			const videoId = strVal(row, videoColIdx);
			const views = numVal(row, viewsIdx);
			const likes = numVal(row, likesIdx);
			const comments = numVal(row, commentsIdx);
			const shares = numVal(row, sharesIdx);

			const snippet = snippetMap.get(videoId);

			const engagement = likes + comments + shares;
			const engagementRate =
				views > 0
					? Math.round((engagement / views) * 10000) / 100
					: 0;

			results.push({
				platform_post_id: videoId,
				content: snippet?.title ?? null,
				published_at: snippet?.publishedAt ?? "",
				media_url:
					snippet?.thumbnails?.medium?.url ??
					snippet?.thumbnails?.default?.url ??
					null,
				media_type: "video",
				impressions: views,
				reach: views,
				likes,
				comments,
				shares,
				saves: 0, // Not available on YouTube
				clicks: 0, // Not available via Analytics API
				engagement_rate: engagementRate,
				platform_url: `https://youtube.com/watch?v=${videoId}`,
			});
		}

		return results;
	},

	// -----------------------------------------------------------------------
	// getAudience
	// -----------------------------------------------------------------------
	async getAudience(
		accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		// Use a wide date range for audience data (last 90 days)
		const to = new Date();
		const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
		const startDate = from.toISOString().slice(0, 10);
		const endDate = to.toISOString().slice(0, 10);

		// Fetch views by country
		const countryData = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate,
			endDate,
			dimensions: "country",
			metrics: "views,estimatedMinutesWatched",
			sort: "-views",
		});

		// Fetch age/gender demographics
		const ageGenderData = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate,
			endDate,
			dimensions: "ageGroup,gender",
			metrics: "viewerPercentage",
		});

		// --- Countries ---
		const topCountries: {
			code: string;
			name: string;
			count: number;
		}[] = [];

		if (countryData?.rows?.length) {
			const countryIdx = colIndex(countryData, "country");
			const viewsIdx = colIndex(countryData, "views");

			for (const row of countryData.rows.slice(0, 20)) {
				const code = strVal(row, countryIdx);
				const views = numVal(row, viewsIdx);
				topCountries.push({
					code,
					name: countryName(code),
					count: views,
				});
			}
		}

		// --- Age / Gender ---
		// YouTube age groups: age13-17, age18-24, age25-34, age35-44, age45-54, age55-64, age65-
		// YouTube gender values: male, female, user_specified
		const ageGroups = new Map<
			string,
			{ male: number; female: number; other: number }
		>();

		if (ageGenderData?.rows?.length) {
			const ageIdx = colIndex(ageGenderData, "ageGroup");
			const genderIdx = colIndex(ageGenderData, "gender");
			const pctIdx = colIndex(ageGenderData, "viewerPercentage");

			for (const row of ageGenderData.rows) {
				const ageGroup = strVal(row, ageIdx).replace("age", "");
				const gender = strVal(row, genderIdx);
				const percentage = numVal(row, pctIdx);

				if (!ageGroups.has(ageGroup)) {
					ageGroups.set(ageGroup, { male: 0, female: 0, other: 0 });
				}
				const group = ageGroups.get(ageGroup)!;

				switch (gender) {
					case "male":
						group.male = percentage;
						break;
					case "female":
						group.female = percentage;
						break;
					default:
						group.other = percentage;
						break;
				}
			}
		}

		const ageGender = Array.from(ageGroups.entries())
			.map(([age_range, counts]) => ({ age_range, ...counts }))
			.sort((a, b) => {
				const totalA = a.male + a.female + a.other;
				const totalB = b.male + b.female + b.other;
				return totalB - totalA;
			});

		return {
			top_cities: [], // YouTube Analytics API does not provide city-level data
			top_countries: topCountries,
			age_gender: ageGender,
		};
	},

	// -----------------------------------------------------------------------
	// getDailyMetrics
	// -----------------------------------------------------------------------
	async getDailyMetrics(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		const analytics = await ytAnalyticsFetch(accessToken, {
			ids: "channel==MINE",
			startDate: dateRange.from,
			endDate: dateRange.to,
			dimensions: "day",
			metrics: "views,likes,comments,shares,subscribersGained",
		});

		if (!analytics?.rows?.length) return [];

		const dayIdx = colIndex(analytics, "day");
		const viewsIdx = colIndex(analytics, "views");
		const likesIdx = colIndex(analytics, "likes");
		const commentsIdx = colIndex(analytics, "comments");
		const sharesIdx = colIndex(analytics, "shares");
		const subsIdx = colIndex(analytics, "subscribersGained");

		return analytics.rows.map((row) => {
			const views = numVal(row, viewsIdx);
			const likes = numVal(row, likesIdx);
			const comments = numVal(row, commentsIdx);
			const shares = numVal(row, sharesIdx);
			const subsGained = numVal(row, subsIdx);

			return {
				date: strVal(row, dayIdx),
				impressions: views,
				engagement: likes + comments + shares,
				reach: views,
				followers: subsGained,
			};
		});
	},
};
