import type { Platform } from "../../schemas/common";

export class PlatformAnalyticsError extends Error {
	constructor(
		message: string,
		public code: "TOKEN_EXPIRED" | "MISSING_PERMISSIONS" | "API_ERROR",
	) {
		super(message);
		this.name = "PlatformAnalyticsError";
	}
}

export interface DateRange {
	from: string; // YYYY-MM-DD
	to: string; // YYYY-MM-DD
}

export interface PlatformOverview {
	followers: number | null;
	follower_change: number | null;
	impressions: number | null;
	impression_change: number | null;
	engagement: number | null;
	engagement_change: number | null;
	engagement_rate: number | null;
	posts_count: number | null;
	reach: number | null;
	reach_change: number | null;
	platform_specific: Record<string, number | string | null>;
}

export interface PlatformPostMetrics {
	platform_post_id: string;
	content: string | null;
	published_at: string;
	media_url: string | null;
	media_type: string | null;
	impressions: number;
	reach: number;
	likes: number;
	comments: number;
	shares: number;
	saves: number;
	clicks: number;
	engagement_rate: number;
	platform_url: string | null;
}

export interface AudienceCity {
	name: string;
	count: number;
}

export interface AudienceCountry {
	code: string;
	name: string;
	count: number;
}

export interface AudienceAgeGender {
	age_range: string;
	male: number;
	female: number;
	other: number;
}

export interface PlatformAudienceDemographics {
	top_cities: AudienceCity[];
	top_countries: AudienceCountry[];
	age_gender: AudienceAgeGender[];
}

export interface DailyMetricPoint {
	date: string;
	impressions: number;
	engagement: number;
	reach: number;
	followers: number;
}

export interface ChannelSummary {
	account_id: string;
	platform: string;
	username: string | null;
	display_name: string | null;
	avatar_url: string | null;
	followers: number | null;
	impressions: number | null;
	engagement_rate: number | null;
	has_analytics: boolean;
	needs_reconnect: boolean;
}

export interface PlatformAnalyticsFetcher {
	getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview>;

	getPostMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
		limit?: number,
	): Promise<PlatformPostMetrics[]>;

	getAudience(
		accessToken: string,
		platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null>;

	getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]>;
}

export const REQUIRED_ANALYTICS_SCOPES: Partial<Record<string, string[]>> = {
	facebook: ["read_insights"],
	instagram: ["instagram_manage_insights", "instagram_business_manage_insights"],
	linkedin: ["r_organization_admin"],
	youtube: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
	tiktok: ["video.list"],
	threads: ["threads_manage_insights"],
};

export const PLATFORMS_WITH_ANALYTICS: string[] = [
	"facebook",
	"instagram",
	"twitter",
	"linkedin",
	"youtube",
	"tiktok",
	"pinterest",
	"threads",
	"googlebusiness",
	"whatsapp",
];

export function hasAnalyticsScopes(
	platform: string,
	accountScopes: string[] | null,
): boolean {
	const required = REQUIRED_ANALYTICS_SCOPES[platform];
	if (!required) return true; // No special scopes needed
	if (!accountScopes || accountScopes.length === 0) return false;
	// At least one of the required scopes must be present
	return required.some((s) => accountScopes.includes(s));
}
