import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const AD_PLATFORMS = [
	"meta",
	"google",
	"tiktok",
	"linkedin",
	"pinterest",
	"twitter",
] as const;

export const AdPlatformEnum = z.enum(AD_PLATFORMS);

export const AD_STATUSES = [
	"draft",
	"pending_review",
	"active",
	"paused",
	"completed",
	"rejected",
	"cancelled",
] as const;

export const AdStatusEnum = z.enum(AD_STATUSES);

export const AD_OBJECTIVES = [
	"awareness",
	"traffic",
	"engagement",
	"leads",
	"conversions",
	"video_views",
] as const;

export const AdObjectiveEnum = z.enum(AD_OBJECTIVES);

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export const AdTargetingSchema = z.object({
	age_min: z.number().int().min(13).max(65).optional(),
	age_max: z.number().int().min(13).max(65).optional(),
	genders: z.array(z.enum(["male", "female", "all"])).optional(),
	locations: z
		.array(
			z.object({
				countries: z.array(z.string()).optional(),
				cities: z.array(z.string()).optional(),
				radius_miles: z.number().optional(),
			}),
		)
		.optional(),
	interests: z
		.array(z.object({ id: z.string(), name: z.string() }))
		.optional(),
	custom_audiences: z.array(z.string()).optional(),
	excluded_audiences: z.array(z.string()).optional(),
	languages: z.array(z.string()).optional(),
	placements: z.array(z.string()).optional(),
	platform_specific: z.record(z.string(), z.any()).optional(),
});

// ---------------------------------------------------------------------------
// Ad Accounts
// ---------------------------------------------------------------------------

export const AdAccountResponse = z.object({
	id: z.string(),
	social_account_id: z.string(),
	platform: AdPlatformEnum,
	platform_ad_account_id: z.string(),
	name: z.string().nullable(),
	currency: z.string().nullable(),
	timezone: z.string().nullable(),
	status: z.string().nullable(),
});

export const ListAdAccountsParams = z.object({
	social_account_id: z
		.string()
		.optional()
		.describe("Filter by social account ID"),
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	q: z.string().max(200).optional().describe("Search by name or platform account ID"),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const CreateCampaignBody = z.object({
	ad_account_id: z.string().describe("Ad account ID"),
	name: z.string().min(1).max(255),
	objective: AdObjectiveEnum,
	daily_budget_cents: z.number().int().positive().optional(),
	lifetime_budget_cents: z.number().int().positive().optional(),
	currency: z.string().length(3).default("USD"),
	start_date: z.string().datetime({ offset: true }).optional(),
	end_date: z.string().datetime({ offset: true }).optional(),
	special_ad_categories: z.array(z.string()).optional(),
});

export const UpdateCampaignBody = z.object({
	name: z.string().min(1).max(255).optional(),
	status: z.enum(["active", "paused"]).optional(),
	daily_budget_cents: z.number().int().positive().optional(),
	lifetime_budget_cents: z.number().int().positive().optional(),
});

export const CampaignResponse = z.object({
	id: z.string(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	platform_campaign_id: z.string().nullable(),
	name: z.string(),
	objective: z.string(),
	status: AdStatusEnum,
	daily_budget_cents: z.number().nullable(),
	lifetime_budget_cents: z.number().nullable(),
	currency: z.string().nullable(),
	start_date: z.string().datetime().nullable(),
	end_date: z.string().datetime().nullable(),
	is_external: z.boolean(),
	ad_count: z.number().optional(),
	metrics: z
		.object({
			impressions: z.number(),
			reach: z.number(),
			clicks: z.number(),
			spend_cents: z.number(),
			conversions: z.number(),
			ctr: z.number(),
			cpc_cents: z.number(),
			cpm_cents: z.number(),
		})
		.optional()
		.nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const CampaignListParams = z.object({
	platform: AdPlatformEnum.optional(),
	status: AdStatusEnum.optional(),
	ad_account_id: z.string().optional(),
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Ads
// ---------------------------------------------------------------------------

export const CreateAdBody = z.object({
	ad_account_id: z.string(),
	campaign_id: z.string().optional().describe("Auto-creates campaign if omitted"),
	name: z.string().min(1).max(255),
	objective: AdObjectiveEnum.optional().describe("Required if campaign_id is omitted"),
	headline: z.string().max(255).optional(),
	body: z.string().optional(),
	call_to_action: z.string().optional(),
	link_url: z.string().url().optional(),
	image_url: z.string().url().optional(),
	video_url: z.string().url().optional(),
	targeting: AdTargetingSchema.optional(),
	daily_budget_cents: z.number().int().positive().optional(),
	lifetime_budget_cents: z.number().int().positive().optional(),
	duration_days: z.number().int().min(1).max(365).optional(),
	start_date: z.string().datetime({ offset: true }).optional(),
	end_date: z.string().datetime({ offset: true }).optional(),
});

export const BoostPostBody = z.object({
	ad_account_id: z.string(),
	post_target_id: z.string().describe("Published post target ID to boost"),
	name: z.string().max(255).optional(),
	objective: AdObjectiveEnum.default("engagement"),
	targeting: AdTargetingSchema.optional(),
	daily_budget_cents: z.number().int().positive(),
	lifetime_budget_cents: z.number().int().positive().optional(),
	currency: z.string().length(3).default("USD"),
	duration_days: z.number().int().min(1).max(365),
	start_date: z.string().datetime({ offset: true }).optional(),
	end_date: z.string().datetime({ offset: true }).optional(),
	bid_amount: z.number().positive().optional(),
	tracking: z
		.object({
			pixel_id: z.string().optional(),
			url_tags: z.string().optional(),
		})
		.optional(),
	special_ad_categories: z.array(z.string()).optional(),
});

export const UpdateAdBody = z.object({
	name: z.string().min(1).max(255).optional(),
	status: z.enum(["active", "paused"]).optional(),
	daily_budget_cents: z.number().int().positive().optional(),
	lifetime_budget_cents: z.number().int().positive().optional(),
	targeting: AdTargetingSchema.optional(),
});

export const AdResponse = z.object({
	id: z.string(),
	campaign_id: z.string(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	platform_ad_id: z.string().nullable(),
	name: z.string(),
	status: AdStatusEnum,
	headline: z.string().nullable(),
	body: z.string().nullable(),
	call_to_action: z.string().nullable(),
	link_url: z.string().nullable(),
	image_url: z.string().nullable(),
	video_url: z.string().nullable(),
	boost_post_target_id: z.string().nullable(),
	targeting: z.any().nullable(),
	daily_budget_cents: z.number().nullable(),
	lifetime_budget_cents: z.number().nullable(),
	start_date: z.string().datetime().nullable(),
	end_date: z.string().datetime().nullable(),
	duration_days: z.number().nullable(),
	is_external: z.boolean(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AdListParams = z.object({
	campaign_id: z.string().optional(),
	platform: AdPlatformEnum.optional(),
	status: AdStatusEnum.optional(),
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	source: z.enum(["all", "internal", "external"]).default("all"),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const AdAnalyticsParams = z.object({
	from: z.string().optional().describe("Start date YYYY-MM-DD"),
	to: z.string().optional().describe("End date YYYY-MM-DD"),
	breakdowns: z
		.string()
		.optional()
		.describe("Comma-separated breakdown dimensions"),
});

export const AdMetricPointSchema = z.object({
	date: z.string(),
	impressions: z.number(),
	reach: z.number(),
	clicks: z.number(),
	spend_cents: z.number(),
	conversions: z.number(),
	video_views: z.number(),
	engagement: z.number(),
	ctr: z.number().optional(),
	cpc_cents: z.number().optional(),
	cpm_cents: z.number().optional(),
});

export const AdAnalyticsResponse = z.object({
	summary: z.object({
		impressions: z.number(),
		reach: z.number(),
		clicks: z.number(),
		spend_cents: z.number(),
		conversions: z.number(),
		ctr: z.number(),
		cpc_cents: z.number(),
		cpm_cents: z.number(),
	}),
	daily: z.array(AdMetricPointSchema),
	demographics: z
		.object({
			age_gender: z.array(z.record(z.string(), z.unknown())).optional(),
			locations: z.array(z.record(z.string(), z.unknown())).optional(),
		})
		.optional(),
});

// ---------------------------------------------------------------------------
// Interests
// ---------------------------------------------------------------------------

export const SearchInterestsParams = z.object({
	q: z.string().min(1).max(200).describe("Search query"),
	social_account_id: z.string().describe("Social account ID"),
});

export const InterestResponse = z.object({
	id: z.string(),
	name: z.string(),
	category: z.string().optional(),
	audience_size: z.number().optional(),
});

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

export const CreateAudienceBody = z.object({
	ad_account_id: z.string(),
	name: z.string().min(1).max(255),
	type: z.enum(["customer_list", "website", "lookalike"]),
	description: z.string().optional(),
	pixel_id: z.string().optional().describe("Required for website audiences"),
	retention_days: z.number().int().min(1).max(180).optional(),
	rule: z.record(z.string(), z.unknown()).optional(),
	source_audience_id: z
		.string()
		.optional()
		.describe("Required for lookalike audiences"),
	country: z.string().length(2).optional(),
	ratio: z.number().min(0.01).max(0.2).optional(),
	customer_file_source: z.string().optional(),
});

export const AudienceResponse = z.object({
	id: z.string(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	platform_audience_id: z.string().nullable(),
	name: z.string(),
	type: z.enum(["customer_list", "website", "lookalike"]),
	description: z.string().nullable(),
	size: z.number().nullable(),
	status: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AddAudienceUsersBody = z.object({
	users: z
		.array(
			z.object({
				email: z.string().email().optional(),
				phone: z.string().optional(),
			}),
		)
		.min(1)
		.max(10000),
});

export const AudienceListParams = z.object({
	ad_account_id: z.string(),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export const SyncResponse = z.object({
	ads_created: z.number(),
	ads_updated: z.number(),
	metrics_updated: z.number(),
});

// ---------------------------------------------------------------------------
// Paginated responses
// ---------------------------------------------------------------------------

export const CampaignListResponse = paginatedResponse(CampaignResponse);
export const AdListResponse = paginatedResponse(AdResponse);
export const AudienceListResponse = paginatedResponse(AudienceResponse);
