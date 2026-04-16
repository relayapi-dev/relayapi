import { z } from "@hono/zod-openapi";
import { PlatformEnum } from "./common";

// --- Query params ---

export const AnalyticsQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	post_id: z.string().optional().describe("Filter by post ID"),
	from_date: z
		.string()
		.optional()
		.describe("Start date (ISO 8601 date string)"),
	to_date: z.string().optional().describe("End date (ISO 8601 date string)"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items"),
	offset: z.coerce.number().int().min(0).default(0).describe("Offset"),
});

export const DailyMetricsQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	from_date: z.string().optional().describe("Start date (ISO 8601)"),
	to_date: z.string().optional().describe("End date (ISO 8601)"),
});

export const ContentDecayQuery = z.object({
	post_id: z.string().describe("Post ID to analyze decay for"),
	days: z.coerce
		.number()
		.int()
		.min(1)
		.max(90)
		.default(30)
		.describe("Number of days to analyze"),
});

export const PostTimelineQuery = z.object({
	post_id: z.string().describe("Post ID"),
	from_date: z.string().optional().describe("Start date (ISO 8601)"),
	to_date: z.string().optional().describe("End date (ISO 8601)"),
});

export const PostingFrequencyQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	from_date: z.string().optional().describe("Start date (ISO 8601)"),
	to_date: z.string().optional().describe("End date (ISO 8601)"),
});

export const YouTubeDailyViewsQuery = z.object({
	account_id: z.string().describe("YouTube account ID"),
	from_date: z.string().optional().describe("Start date (ISO 8601)"),
	to_date: z.string().optional().describe("End date (ISO 8601)"),
});

// --- Response schemas ---

export const PostAnalytics = z.object({
	post_id: z.string().describe("Post ID"),
	platform: PlatformEnum,
	impressions: z.number().nullable().optional().describe("Total impressions"),
	reach: z.number().nullable().optional().describe("Total reach"),
	likes: z.number().nullable().optional().describe("Total likes"),
	comments: z.number().nullable().optional().describe("Total comments"),
	shares: z.number().nullable().optional().describe("Total shares"),
	saves: z.number().nullable().optional().describe("Total saves"),
	clicks: z.number().nullable().optional().describe("Total clicks"),
	views: z.number().nullable().optional().describe("Total views"),
	published_at: z.string().datetime().describe("Published timestamp"),
});

export const AnalyticsOverview = z.object({
	total_posts: z.number().describe("Total number of posts"),
	total_impressions: z.number().describe("Total impressions across posts"),
	total_likes: z.number().describe("Total likes across posts"),
	total_comments: z.number().describe("Total comments across posts"),
	total_shares: z.number().describe("Total shares across posts"),
	total_clicks: z.number().describe("Total clicks across posts"),
	total_views: z.number().describe("Total views across posts"),
});

export const AnalyticsResponse = z.object({
	data: z.array(PostAnalytics),
	overview: AnalyticsOverview.optional(),
	truncated: z
		.boolean()
		.optional()
		.describe(
			"True when the matching target set exceeds the per-response cap. Narrow by from_date/to_date/platform to see the full set.",
		),
});

export const DailyMetric = z.object({
	date: z.string().describe("Date (YYYY-MM-DD)"),
	post_count: z.number().describe("Posts published on this date"),
	platforms: z
		.record(z.string(), z.number())
		.describe("Post count per platform"),
	impressions: z.number().describe("Total impressions"),
	likes: z.number().describe("Total likes"),
	comments: z.number().describe("Total comments"),
	shares: z.number().describe("Total shares"),
	clicks: z.number().describe("Total clicks"),
	views: z.number().describe("Total views"),
});

export const DailyMetricsResponse = z.object({
	data: z.array(DailyMetric),
});

export const BestTimeSlot = z.object({
	day_of_week: z
		.number()
		.int()
		.min(0)
		.max(6)
		.describe("Day of week (0=Sunday)"),
	hour_utc: z.number().int().min(0).max(23).describe("Hour in UTC"),
	avg_engagement: z.number().describe("Average engagement score"),
	post_count: z.number().describe("Number of posts analyzed"),
});

export const BestTimeResponse = z.object({
	data: z.array(BestTimeSlot),
});

export const ContentDecayPoint = z.object({
	day: z.number().describe("Days since publication"),
	impressions: z.number().describe("Impressions on this day"),
	engagement: z.number().describe("Engagement on this day"),
	cumulative_impressions: z.number().describe("Cumulative impressions"),
	cumulative_engagement: z.number().describe("Cumulative engagement"),
});

export const ContentDecayResponse = z.object({
	post_id: z.string(),
	platform: PlatformEnum,
	data: z.array(ContentDecayPoint),
	half_life_days: z
		.number()
		.nullable()
		.describe("Days until engagement halved"),
});

export const PostTimelinePoint = z.object({
	date: z.string().describe("Date (YYYY-MM-DD)"),
	impressions: z.number(),
	likes: z.number(),
	comments: z.number(),
	shares: z.number(),
	clicks: z.number(),
	views: z.number(),
});

export const PostTimelineResponse = z.object({
	post_id: z.string(),
	data: z.array(PostTimelinePoint),
});

export const PostingFrequencyBucket = z.object({
	posts_per_week: z.number().describe("Average posts per week in bucket"),
	avg_engagement: z.number().describe("Average engagement"),
	avg_impressions: z.number().describe("Average impressions"),
	sample_weeks: z.number().describe("Number of weeks in sample"),
});

export const PostingFrequencyResponse = z.object({
	data: z.array(PostingFrequencyBucket),
	optimal_frequency: z
		.number()
		.nullable()
		.describe("Recommended posts per week"),
});

export const YouTubeDailyView = z.object({
	date: z.string().describe("Date (YYYY-MM-DD)"),
	views: z.number().describe("Total views"),
	watch_time_minutes: z.number().describe("Watch time in minutes"),
	subscribers_gained: z.number().describe("Net subscribers gained"),
});

export const YouTubeDailyViewsResponse = z.object({
	data: z.array(YouTubeDailyView),
});
