import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";
import { getLinkedInRestHeaders, LINKEDIN_API_BASE } from "../../lib/linkedin-rest";

// Country code to name mapping for LinkedIn geo facets
const COUNTRY_NAMES: Record<string, string> = {
	us: "United States",
	gb: "United Kingdom",
	ca: "Canada",
	au: "Australia",
	de: "Germany",
	fr: "France",
	in: "India",
	br: "Brazil",
	nl: "Netherlands",
	es: "Spain",
	it: "Italy",
	se: "Sweden",
	ch: "Switzerland",
	jp: "Japan",
	sg: "Singapore",
	mx: "Mexico",
	ie: "Ireland",
	be: "Belgium",
	at: "Austria",
	dk: "Denmark",
	no: "Norway",
	fi: "Finland",
	pl: "Poland",
	pt: "Portugal",
	nz: "New Zealand",
	za: "South Africa",
	ae: "United Arab Emirates",
	il: "Israel",
	kr: "South Korea",
	cn: "China",
	hk: "Hong Kong",
	tw: "Taiwan",
	ar: "Argentina",
	co: "Colombia",
	cl: "Chile",
	ph: "Philippines",
	my: "Malaysia",
	th: "Thailand",
	id: "Indonesia",
	vn: "Vietnam",
	ro: "Romania",
	cz: "Czech Republic",
	hu: "Hungary",
	gr: "Greece",
	tr: "Turkey",
	ng: "Nigeria",
	ke: "Kenya",
	eg: "Egypt",
	sa: "Saudi Arabia",
	pk: "Pakistan",
	bd: "Bangladesh",
	ua: "Ukraine",
	ru: "Russia",
};

function getCountryName(code: string): string {
	return COUNTRY_NAMES[code.toLowerCase()] || code.toUpperCase();
}

/**
 * Helper to make authenticated LinkedIn API requests with required headers.
 */
async function linkedinFetch(
	accessToken: string,
	path: string,
): Promise<Response> {
	const url = path.startsWith("http") ? path : `${LINKEDIN_API_BASE}${path}`;
	return fetch(url, {
		headers: getLinkedInRestHeaders(accessToken),
	});
}

/**
 * Convert a YYYY-MM-DD date string to milliseconds since epoch (start of day UTC).
 */
function dateToMs(dateStr: string): number {
	return new Date(`${dateStr}T00:00:00.000Z`).getTime();
}

/**
 * Calculate a previous period of the same length for comparison.
 * E.g., if the range is 7 days, the previous period is the 7 days before that.
 */
function getPreviousPeriod(dateRange: DateRange): DateRange {
	const fromMs = dateToMs(dateRange.from);
	const toMs = dateToMs(dateRange.to);
	const durationMs = toMs - fromMs;
	const prevFrom = new Date(fromMs - durationMs);
	const prevTo = new Date(fromMs);
	return {
		from: prevFrom.toISOString().split("T")[0] ?? "",
		to: prevTo.toISOString().split("T")[0] ?? "",
	};
}

interface ShareStatElement {
	timeRange?: { start: number; end: number };
	totalShareStatistics?: {
		impressionCount?: number;
		uniqueImpressionsCount?: number;
		clickCount?: number;
		likeCount?: number;
		commentCount?: number;
		shareCount?: number;
		engagement?: number;
	};
}

interface ShareStatsResponse {
	elements?: ShareStatElement[];
}

/**
 * Fetch share statistics for an organization over a date range.
 */
async function fetchShareStatistics(
	accessToken: string,
	orgId: string,
	dateRange: DateRange,
): Promise<ShareStatElement[]> {
	const fromMs = dateToMs(dateRange.from);
	const toMs = dateToMs(dateRange.to);
	const orgUrn = `urn:li:organization:${orgId}`;
	const path =
		`/rest/organizationalEntityShareStatistics` +
		`?q=organizationalEntity` +
		`&organizationalEntity=${encodeURIComponent(orgUrn)}` +
		`&timeIntervals.timeGranularityType=DAY` +
		`&timeIntervals.timeRange.start=${fromMs}` +
		`&timeIntervals.timeRange.end=${toMs}`;

	const res = await linkedinFetch(accessToken, path);
	if (!res.ok) {
		const errBody = await res.text();
		console.error(
			`LinkedIn share statistics error (${res.status}): ${errBody}`,
		);
		return [];
	}

	const data = (await res.json()) as ShareStatsResponse;
	return data.elements ?? [];
}

interface FollowerCountBreakdown {
	organicFollowerCount?: number;
	paidFollowerCount?: number;
}

interface FollowerStatsElement {
	followerCounts?: FollowerCountBreakdown;
	followerCountsByGeo?: Array<{
		geo: string;
		followerCounts: FollowerCountBreakdown;
	}>;
	followerCountsByFunction?: Array<{
		function: string;
		followerCounts: FollowerCountBreakdown;
	}>;
	followerCountsByIndustry?: Array<{
		industry: string;
		followerCounts: FollowerCountBreakdown;
	}>;
	followerCountsBySeniority?: Array<{
		seniority: string;
		followerCounts: FollowerCountBreakdown;
	}>;
	timeRange?: { start: number; end: number };
}

interface FollowerStatsResponse {
	elements?: FollowerStatsElement[];
}

/**
 * Fetch follower statistics for an organization.
 */
async function fetchFollowerStatistics(
	accessToken: string,
	orgId: string,
): Promise<FollowerStatsElement | null> {
	const orgUrn = `urn:li:organization:${orgId}`;
	const path =
		`/rest/organizationalEntityFollowerStatistics` +
		`?q=organizationalEntity` +
		`&organizationalEntity=${encodeURIComponent(orgUrn)}`;

	const res = await linkedinFetch(accessToken, path);
	if (!res.ok) {
		const errBody = await res.text();
		console.error(
			`LinkedIn follower statistics error (${res.status}): ${errBody}`,
		);
		return null;
	}

	const data = (await res.json()) as FollowerStatsResponse;
	return data.elements?.[0] ?? null;
}

/**
 * Fetch follower statistics with daily granularity for time-series data.
 */
async function fetchDailyFollowerStatistics(
	accessToken: string,
	orgId: string,
	dateRange: DateRange,
): Promise<FollowerStatsElement[]> {
	const fromMs = dateToMs(dateRange.from);
	const toMs = dateToMs(dateRange.to);
	const orgUrn = `urn:li:organization:${orgId}`;
	const path =
		`/rest/organizationalEntityFollowerStatistics` +
		`?q=organizationalEntity` +
		`&organizationalEntity=${encodeURIComponent(orgUrn)}` +
		`&timeIntervals.timeGranularityType=DAY` +
		`&timeIntervals.timeRange.start=${fromMs}` +
		`&timeIntervals.timeRange.end=${toMs}`;

	const res = await linkedinFetch(accessToken, path);
	if (!res.ok) {
		const errBody = await res.text();
		console.error(
			`LinkedIn daily follower statistics error (${res.status}): ${errBody}`,
		);
		return [];
	}

	const data = (await res.json()) as FollowerStatsResponse;
	return data.elements ?? [];
}

function getTotalFollowers(counts: FollowerCountBreakdown | undefined): number {
	if (!counts) return 0;
	return (counts.organicFollowerCount ?? 0) + (counts.paidFollowerCount ?? 0);
}

function sumShareStats(elements: ShareStatElement[]): {
	impressions: number;
	clicks: number;
	likes: number;
	comments: number;
	shares: number;
	engagement: number;
	uniqueImpressions: number;
} {
	let impressions = 0;
	let clicks = 0;
	let likes = 0;
	let comments = 0;
	let shares = 0;
	let uniqueImpressions = 0;

	for (const el of elements) {
		const stats = el.totalShareStatistics;
		if (!stats) continue;
		impressions += stats.impressionCount ?? 0;
		clicks += stats.clickCount ?? 0;
		likes += stats.likeCount ?? 0;
		comments += stats.commentCount ?? 0;
		shares += stats.shareCount ?? 0;
		uniqueImpressions += stats.uniqueImpressionsCount ?? 0;
	}

	return {
		impressions,
		clicks,
		likes,
		comments,
		shares,
		engagement: likes + comments + shares,
		uniqueImpressions,
	};
}

interface LinkedInPost {
	id: string;
	author: string;
	commentary?: string;
	createdAt?: number;
	lastModifiedAt?: number;
	publishedAt?: number;
	content?: {
		media?: { id?: string };
		article?: { source?: string; thumbnail?: string };
		multiImage?: { images?: Array<{ id?: string }> };
	};
	lifecycleState?: string;
}

interface PostsResponse {
	elements?: LinkedInPost[];
}

export const linkedinAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		const orgId = platformAccountId;

		// Fetch current period share stats, previous period share stats, and follower stats in parallel
		const previousPeriod = getPreviousPeriod(dateRange);
		const [currentElements, previousElements, followerStats] =
			await Promise.all([
				fetchShareStatistics(accessToken, orgId, dateRange),
				fetchShareStatistics(accessToken, orgId, previousPeriod),
				fetchFollowerStatistics(accessToken, orgId),
			]);

		const current = sumShareStats(currentElements);
		const previous = sumShareStats(previousElements);

		const followers = getTotalFollowers(followerStats?.followerCounts);
		const engagementRate =
			current.impressions > 0
				? (current.engagement / current.impressions) * 100
				: null;

		const impressionChange =
			previous.impressions > 0
				? ((current.impressions - previous.impressions) /
						previous.impressions) *
					100
				: null;

		const engagementChange =
			previous.engagement > 0
				? ((current.engagement - previous.engagement) /
						previous.engagement) *
					100
				: null;

		return {
			followers,
			follower_change: null, // LinkedIn does not expose historical follower totals for simple comparison
			impressions: current.impressions,
			impression_change: impressionChange,
			engagement: current.engagement,
			engagement_change: engagementChange,
			engagement_rate: engagementRate,
			posts_count: null,
			reach: current.uniqueImpressions || null,
			reach_change: null,
			platform_specific: {
				clicks: current.clicks,
				likes: current.likes,
				comments: current.comments,
				shares: current.shares,
			},
		};
	},

	async getPostMetrics(
		accessToken: string,
		platformAccountId: string,
		_dateRange: DateRange,
		limit = 20,
	): Promise<PlatformPostMetrics[]> {
		const orgId = platformAccountId;
		const orgUrn = `urn:li:organization:${orgId}`;

		// 1. Fetch organization posts
		const postsPath =
			`/rest/posts` +
			`?q=author` +
			`&author=${encodeURIComponent(orgUrn)}` +
			`&count=${limit}` +
			`&sortBy=LAST_MODIFIED`;

		const postsRes = await linkedinFetch(accessToken, postsPath);
		if (!postsRes.ok) {
			const errBody = await postsRes.text();
			console.error(
				`LinkedIn posts fetch error (${postsRes.status}): ${errBody}`,
			);
			return [];
		}

		const postsData = (await postsRes.json()) as PostsResponse;
		const posts = postsData.elements ?? [];

		if (posts.length === 0) return [];

		// 2. Fetch per-share statistics for these posts
		// Build the shares query parameter for batch lookup
		const shareParams = posts
			.map((post, idx) => {
				// Post IDs from the posts API are in the format "urn:li:share:{id}" or "urn:li:ugcPost:{id}"
				const shareUrn = post.id;
				return `shares[${idx}]=${encodeURIComponent(shareUrn)}`;
			})
			.join("&");

		const statsPath =
			`/rest/organizationalEntityShareStatistics` +
			`?q=organizationalEntity` +
			`&organizationalEntity=${encodeURIComponent(orgUrn)}` +
			`&${shareParams}`;

		const statsRes = await linkedinFetch(accessToken, statsPath);
		const statsMap = new Map<string, ShareStatElement>();

		if (statsRes.ok) {
			const statsData = (await statsRes.json()) as {
				elements?: Array<ShareStatElement & { share?: string }>;
			};
			for (const el of statsData.elements ?? []) {
				if (el.share) {
					statsMap.set(el.share, el);
				}
			}
		} else {
			const errBody = await statsRes.text();
			console.error(
				`LinkedIn share stats fetch error (${statsRes.status}): ${errBody}`,
			);
		}

		// 3. Map to PlatformPostMetrics
		return posts.map((post) => {
			const stats = statsMap.get(post.id);
			const totalStats = stats?.totalShareStatistics;

			const impressions = totalStats?.impressionCount ?? 0;
			const likes = totalStats?.likeCount ?? 0;
			const comments = totalStats?.commentCount ?? 0;
			const shares = totalStats?.shareCount ?? 0;
			const clicks = totalStats?.clickCount ?? 0;
			const uniqueImpressions = totalStats?.uniqueImpressionsCount ?? 0;
			const engagement = likes + comments + shares;
			const engagementRate =
				impressions > 0 ? (engagement / impressions) * 100 : 0;

			// Determine media URL/type if available
			let mediaUrl: string | null = null;
			let mediaType: string | null = null;
			if (post.content?.article?.thumbnail) {
				mediaUrl = post.content.article.thumbnail;
				mediaType = "image";
			} else if (post.content?.article?.source) {
				mediaUrl = post.content.article.source;
				mediaType = "link";
			}

			// Extract the post ID for URL construction
			// Post URNs can be "urn:li:share:{id}" or "urn:li:ugcPost:{id}"
			const postIdParts = post.id.split(":");
			const postNumericId = postIdParts[postIdParts.length - 1];

			const publishedAt = post.publishedAt ?? post.createdAt ?? 0;

			return {
				platform_post_id: post.id,
				content: post.commentary ?? null,
				published_at: new Date(publishedAt).toISOString(),
				media_url: mediaUrl,
				media_type: mediaType,
				impressions,
				reach: uniqueImpressions,
				likes,
				comments,
				shares,
				saves: 0, // LinkedIn does not expose save counts
				clicks,
				engagement_rate: engagementRate,
				platform_url: `https://www.linkedin.com/feed/update/${post.id}`,
			};
		});
	},

	async getAudience(
		accessToken: string,
		platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		const followerStats = await fetchFollowerStatistics(
			accessToken,
			platformAccountId,
		);

		if (!followerStats) return null;

		// Parse country (geo) data
		const topCountries = (followerStats.followerCountsByGeo ?? [])
			.map((entry) => {
				const total = getTotalFollowers(entry.followerCounts);
				// The geo field contains a country code like "urn:li:geo:103644278" or a country code
				const geoCode = entry.geo.includes(":")
					? entry.geo.split(":").pop() ?? entry.geo
					: entry.geo;
				return {
					code: geoCode,
					name: getCountryName(geoCode),
					count: total,
				};
			})
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		return {
			top_cities: [], // LinkedIn does not provide city-level follower data
			top_countries: topCountries,
			age_gender: [], // LinkedIn does not provide age/gender breakdowns
		};
	},

	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		const orgId = platformAccountId;

		// Fetch share statistics and follower statistics with daily granularity in parallel
		const [shareElements, followerElements] = await Promise.all([
			fetchShareStatistics(accessToken, orgId, dateRange),
			fetchDailyFollowerStatistics(accessToken, orgId, dateRange),
		]);

		// Build a map of date -> follower count from follower time series
		const followerByDate = new Map<string, number>();
		for (const el of followerElements) {
			if (el.timeRange?.start) {
				const dateStr =
					new Date(el.timeRange.start).toISOString().split("T")[0] ?? "";
				followerByDate.set(dateStr, getTotalFollowers(el.followerCounts));
			}
		}

		// Map share elements to daily metric points
		const dailyMetrics: DailyMetricPoint[] = [];

		for (const el of shareElements) {
			if (!el.timeRange?.start) continue;

			const dateStr =
				new Date(el.timeRange.start).toISOString().split("T")[0] ?? "";
			const stats = el.totalShareStatistics;

			const impressions = stats?.impressionCount ?? 0;
			const likes = stats?.likeCount ?? 0;
			const comments = stats?.commentCount ?? 0;
			const shares = stats?.shareCount ?? 0;
			const uniqueImpressions = stats?.uniqueImpressionsCount ?? 0;

			dailyMetrics.push({
				date: dateStr,
				impressions,
				engagement: likes + comments + shares,
				reach: uniqueImpressions,
				followers: followerByDate.get(dateStr) ?? 0,
			});
		}

		// Sort by date ascending
		dailyMetrics.sort((a, b) => a.date.localeCompare(b.date));

		return dailyMetrics;
	},
};
