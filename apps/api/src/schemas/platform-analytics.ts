import { z } from "@hono/zod-openapi";
import { PlatformEnum } from "./common";

export const PlatformAnalyticsQuery = z.object({
	account_id: z.string().describe("Social account ID"),
	from_date: z
		.string()
		.optional()
		.describe("Start date (YYYY-MM-DD). Defaults to 30 days ago"),
	to_date: z
		.string()
		.optional()
		.describe("End date (YYYY-MM-DD). Defaults to today"),
});

export const PlatformPostsQuery = PlatformAnalyticsQuery.extend({
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of posts to return"),
});

export const PlatformOverviewResponse = z.object({
	followers: z.number().nullable(),
	follower_change: z.number().nullable(),
	impressions: z.number().nullable(),
	impression_change: z.number().nullable(),
	engagement: z.number().nullable(),
	engagement_change: z.number().nullable(),
	engagement_rate: z.number().nullable(),
	posts_count: z.number().nullable(),
	reach: z.number().nullable(),
	reach_change: z.number().nullable(),
	platform_specific: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});

export const PlatformPostMetricsSchema = z.object({
	platform_post_id: z.string(),
	content: z.string().nullable(),
	published_at: z.string(),
	media_url: z.string().nullable(),
	media_type: z.string().nullable(),
	impressions: z.number(),
	reach: z.number(),
	likes: z.number(),
	comments: z.number(),
	shares: z.number(),
	saves: z.number(),
	clicks: z.number(),
	engagement_rate: z.number(),
	platform_url: z.string().nullable(),
});

export const PlatformPostsResponse = z.object({
	data: z.array(PlatformPostMetricsSchema),
});

export const AudienceCitySchema = z.object({
	name: z.string(),
	count: z.number(),
});

export const AudienceCountrySchema = z.object({
	code: z.string(),
	name: z.string(),
	count: z.number(),
});

export const AudienceAgeGenderSchema = z.object({
	age_range: z.string(),
	male: z.number(),
	female: z.number(),
	other: z.number(),
});

export const PlatformAudienceResponse = z.object({
	top_cities: z.array(AudienceCitySchema),
	top_countries: z.array(AudienceCountrySchema),
	age_gender: z.array(AudienceAgeGenderSchema),
	available: z.boolean().describe("Whether audience data is available for this platform"),
});

export const DailyMetricPointSchema = z.object({
	date: z.string(),
	impressions: z.number(),
	engagement: z.number(),
	reach: z.number(),
	followers: z.number(),
});

export const PlatformDailyResponse = z.object({
	data: z.array(DailyMetricPointSchema),
});

export const ChannelSummarySchema = z.object({
	account_id: z.string(),
	platform: z.string(),
	username: z.string().nullable(),
	display_name: z.string().nullable(),
	avatar_url: z.string().nullable(),
	followers: z.number().nullable(),
	impressions: z.number().nullable(),
	engagement_rate: z.number().nullable(),
	has_analytics: z.boolean(),
	needs_reconnect: z.boolean(),
});

export const ChannelsResponse = z.object({
	data: z.array(ChannelSummarySchema),
	totals: z.object({
		total_audience: z.number(),
		total_impressions: z.number(),
		total_engagement: z.number(),
		audience_change: z.number().nullable(),
		impressions_change: z.number().nullable(),
		engagement_change: z.number().nullable(),
	}),
});

export const ChannelsQuery = z.object({
	from_date: z
		.string()
		.optional()
		.describe("Start date (YYYY-MM-DD). Defaults to 30 days ago"),
	to_date: z
		.string()
		.optional()
		.describe("End date (YYYY-MM-DD). Defaults to today"),
});
