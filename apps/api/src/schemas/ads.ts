import { z } from "@hono/zod-openapi";
import { AD_AUDIENCE_TYPES } from "@relayapi/db";
import { AD_BUDGET_MAX_MINOR_UNITS } from "../lib/ad-money";
import { isContactPhone } from "../lib/contact-phone";
import {
	AdCampaignProviderOptionsSchema,
	AdCreateProviderOptionsSchema,
} from "./ad-provider-options";
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

export const AdCapabilityStateEnum = z.enum([
	"supported",
	"requires_approval",
	"unsupported",
]);

export const AdCapabilityResponse = z.object({
	state: AdCapabilityStateEnum,
	reason: z.string().optional(),
});

export const AdPlatformCapabilitiesResponse = z.object({
	platform: AdPlatformEnum,
	api_version: z.string(),
	auth_protocol: z.enum(["oauth2", "oauth1"]),
	requires_dedicated_connection: z.literal(true),
	required_scopes: z.array(z.string()),
	operations: z.record(z.string(), AdCapabilityResponse),
	objectives: z.array(z.string()),
	formats: z.array(z.string()),
	official_docs: z.array(z.string().url()),
});

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

const AdBudgetMinorUnits = z
	.number()
	.int()
	.positive()
	.max(AD_BUDGET_MAX_MINOR_UNITS);
const RequestedAdCurrency = z
	.string()
	.regex(/^[A-Za-z]{3}$/)
	.transform((value) => value.toUpperCase());

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
				countries: z.array(z.string().min(1)).optional(),
				cities: z
					.array(z.string().min(1))
					.optional()
					.describe(
						"Meta location keys returned by the Marketing API targeting search, not display names",
					),
				radius_miles: z
					.number()
					.positive()
					.optional()
					.describe("Radius applied to each city key in this location entry"),
			}),
		)
		.optional(),
	interests: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
	custom_audiences: z.array(z.string()).optional(),
	excluded_audiences: z.array(z.string()).optional(),
	languages: z
		.array(z.string().regex(/^\d+$/))
		.optional()
		.describe("Meta numeric ad-locale IDs encoded as strings"),
	placements: z.array(z.string()).optional(),
	platform_specific: z
		.record(z.string(), z.any())
		.optional()
		.describe(
			"Additional raw Meta targeting-spec fields; normalized RelayAPI fields take precedence on conflicts",
		),
});

// ---------------------------------------------------------------------------
// Ad Accounts
// ---------------------------------------------------------------------------

export const BoostableAccount = z.object({
	id: z.string(),
	platform: z.string(),
	username: z.string().nullable(),
});

export const AdConnectionResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	platform: AdPlatformEnum,
	provider_principal_id: z.string(),
	display_name: z.string().nullable(),
	status: z.enum(["pending", "active", "expired", "revoked", "error"]),
	credential_version: z.number().int().positive(),
	scopes: z.array(z.string()),
	access_token_expires_at: z.string().datetime().nullable(),
	refresh_token_expires_at: z.string().datetime().nullable(),
	last_error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

const AdConnectionSecret = z.string().min(1).max(32_768).openapi({
	format: "password",
	writeOnly: true,
	description:
		"Write-only provider credential. RelayAPI encrypts this value and never returns it.",
});

export const AdConnectionCredentialMetadata = z.object({
	login_customer_id: z
		.string()
		.regex(/^\d[\d-]{0,31}$/)
		.optional()
		.describe("Google Ads manager customer ID, with or without hyphens"),
	advertiser_ids: z
		.array(z.string().regex(/^\d+$/))
		.min(1)
		.max(100)
		.optional()
		.describe("TikTok advertiser IDs returned by the Business OAuth exchange"),
});

const AdConnectionCredentialFields = z.object({
	access_token: AdConnectionSecret,
	refresh_token: AdConnectionSecret.optional(),
	token_secret: AdConnectionSecret.optional().describe(
		"Required for X Ads OAuth 1.0a; not accepted as a substitute for an OAuth 2 refresh token",
	),
	access_token_expires_at: z.string().datetime({ offset: true }).optional(),
	refresh_token_expires_at: z.string().datetime({ offset: true }).optional(),
	scopes: z.array(z.string().trim().min(1).max(255)).max(128).default([]),
	metadata: AdConnectionCredentialMetadata.optional(),
});

export const CreateAdConnectionBody = AdConnectionCredentialFields.extend({
	platform: AdPlatformEnum,
	workspace_id: z.string().optional(),
	provider_principal_id: z.string().trim().min(1).max(255),
	display_name: z.string().trim().min(1).max(255).optional(),
}).superRefine((value, ctx) => {
	if (value.platform === "twitter" && !value.token_secret) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["token_secret"],
			message: "X Ads requires an OAuth 1.0a token_secret",
		});
	}
	if (value.platform === "tiktok" && !value.metadata?.advertiser_ids?.length) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["metadata", "advertiser_ids"],
			message: "TikTok Ads requires the authorized advertiser_ids",
		});
	}
});

export const RotateAdConnectionCredentialsBody = AdConnectionCredentialFields;

export const AdConnectionMutationResponse = z.object({
	connection: AdConnectionResponse,
	validated_ad_accounts: z.number().int().nonnegative(),
});

export const ListAdConnectionsParams = z.object({
	platform: AdPlatformEnum.optional(),
	workspace_id: z.string().optional(),
	status: z
		.enum(["pending", "active", "expired", "revoked", "error"])
		.optional(),
});

export const DiscoverAdAccountsBody = z.object({
	ad_connection_id: z.string(),
});

export const AdAccountResponse = z.object({
	id: z.string(),
	ad_connection_id: z.string().nullable(),
	social_account_id: z.string().nullable(),
	platform: AdPlatformEnum,
	platform_ad_account_id: z.string(),
	name: z.string().nullable(),
	currency: z.string().nullable(),
	timezone: z.string().nullable(),
	status: z.string().nullable(),
	capabilities: z.record(z.string(), AdCapabilityResponse),
	boostable_social_account_ids: z
		.array(z.string())
		.default([])
		.describe(
			"Connected social account IDs whose published posts this ad account can boost",
		),
	boostable_accounts: z
		.array(BoostableAccount)
		.default([])
		.describe("Connected Pages/IG accounts this ad account can promote"),
});

export const ListAdAccountsParams = z.object({
	social_account_id: z
		.string()
		.optional()
		.describe("Filter by social account ID"),
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	q: z
		.string()
		.max(200)
		.optional()
		.describe("Search by name or platform account ID"),
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
	daily_budget_cents: AdBudgetMinorUnits.optional(),
	lifetime_budget_cents: AdBudgetMinorUnits.optional(),
	currency: RequestedAdCurrency.optional(),
	start_date: z.string().datetime({ offset: true }).optional(),
	end_date: z.string().datetime({ offset: true }).optional(),
	special_ad_categories: z.array(z.string()).optional(),
	provider_options: AdCampaignProviderOptionsSchema.optional().describe(
		"Provider-specific campaign settings. The platform discriminator must match the selected ad account.",
	),
});

export const UpdateCampaignBody = z.object({
	name: z.string().min(1).max(255).optional(),
	status: z.enum(["active", "paused"]).optional(),
	daily_budget_cents: AdBudgetMinorUnits.optional(),
	lifetime_budget_cents: AdBudgetMinorUnits.optional(),
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
	campaign_id: z
		.string()
		.optional()
		.describe(
			"Auto-creates a campaign if omitted. When supplied, campaign/ad-set settings (objective, targeting, budgets, duration, and schedule) cannot be overridden.",
		),
	name: z.string().min(1).max(255),
	objective: AdObjectiveEnum.optional().describe(
		"Required if campaign_id is omitted",
	),
	headline: z.string().max(255).optional(),
	body: z.string().optional(),
	call_to_action: z.string().optional(),
	link_url: z.string().url().optional(),
	image_url: z.string().url().optional(),
	video_url: z.string().url().optional(),
	targeting: AdTargetingSchema.optional(),
	daily_budget_cents: AdBudgetMinorUnits.optional(),
	lifetime_budget_cents: AdBudgetMinorUnits.optional(),
	duration_days: z.number().int().min(1).max(365).optional(),
	start_date: z.string().datetime({ offset: true }).optional(),
	end_date: z.string().datetime({ offset: true }).optional(),
	provider_options: AdCreateProviderOptionsSchema.optional().describe(
		"Provider-specific campaign and creative settings. The platform discriminator must match the selected ad account.",
	),
});

export const BoostPostBody = z
	.object({
		ad_account_id: z.string(),
		post_target_id: z
			.string()
			.optional()
			.describe("Published RelayAPI post target ID (pt_) to boost"),
		external_post_id: z
			.string()
			.optional()
			.describe("Natively-published / external post ID (xp_) to boost"),
		name: z.string().max(255).optional(),
		objective: AdObjectiveEnum.default("engagement"),
		targeting: AdTargetingSchema.optional(),
		daily_budget_cents: AdBudgetMinorUnits,
		lifetime_budget_cents: AdBudgetMinorUnits.optional(),
		currency: RequestedAdCurrency.optional(),
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
		provider_options: AdCreateProviderOptionsSchema.optional().describe(
			"Provider-specific campaign and existing-post creative settings. Required by non-Meta providers.",
		),
	})
	.refine((b) => Boolean(b.post_target_id) !== Boolean(b.external_post_id), {
		message: "Provide exactly one of post_target_id or external_post_id",
	});

export const UpdateAdBody = z.object({
	name: z.string().min(1).max(255).optional(),
	status: z.enum(["active", "paused"]).optional(),
	daily_budget_cents: AdBudgetMinorUnits.optional(),
	lifetime_budget_cents: AdBudgetMinorUnits.optional(),
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
	boost_external_post_id: z.string().nullable(),
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

export const SearchInterestsParams = z
	.object({
		q: z.string().min(1).max(200).describe("Search query"),
		ad_account_id: z
			.string()
			.optional()
			.describe("Ad account ID; required for dedicated ad connections"),
		social_account_id: z
			.string()
			.optional()
			.describe("Deprecated Meta-only compatibility selector"),
	})
	.refine(
		(value) =>
			Boolean(value.ad_account_id) !== Boolean(value.social_account_id),
		{
			message: "Provide exactly one of ad_account_id or social_account_id",
		},
	);

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
	type: z.enum(AD_AUDIENCE_TYPES),
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
	type: z.enum(AD_AUDIENCE_TYPES),
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
				phone: z
					.string()
					.refine(
						(value) => isContactPhone(value, { allowBareInternational: true }),
						{
							message: "Phone must carry an international country calling code",
						},
					)
					.optional(),
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

// Manual sync now runs asynchronously on the ADS queue (the full Graph
// fetch + per-ad upserts + metrics refresh can exceed the request window).
// The endpoint acknowledges with 202 + { status: "queued" }; clients poll the
// ad sync logs / list endpoints for completion counts.
export const SyncQueuedResponse = z.object({
	status: z.literal("queued"),
});

// ---------------------------------------------------------------------------
// Paginated responses
// ---------------------------------------------------------------------------

export const CampaignListResponse = paginatedResponse(CampaignResponse);
export const AdListResponse = paginatedResponse(AdResponse);
export const AudienceListResponse = paginatedResponse(AudienceResponse);
