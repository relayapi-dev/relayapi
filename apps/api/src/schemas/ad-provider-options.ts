import { z } from "@hono/zod-openapi";

const PositiveMinorUnits = z.number().int().positive();
const PositiveProviderId = z.string().regex(/^\d+$/);

const GoogleKeyword = z.object({
	text: z.string().trim().min(1).max(80),
	match_type: z.enum(["BROAD", "PHRASE", "EXACT"]),
});

const GoogleNetworkSettings = z.object({
	target_google_search: z.boolean().default(true),
	target_search_network: z.boolean().default(true),
	target_content_network: z.boolean().default(false),
	target_partner_search_network: z.boolean().default(false),
});

export const GoogleCampaignProviderSettings = z.object({
	contains_eu_political_advertising: z.enum([
		"CONTAINS_EU_POLITICAL_ADVERTISING",
		"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
	]),
	bidding_strategy: z
		.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS"])
		.default("MANUAL_CPC"),
	keywords: z.array(GoogleKeyword).min(1).max(100),
	default_cpc_bid_cents: PositiveMinorUnits.optional(),
	network_settings: GoogleNetworkSettings.optional(),
	geo_target_constant_ids: z
		.array(z.string().regex(/^\d+$/))
		.max(100)
		.optional(),
	language_constant_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
});

const GoogleResponsiveSearchCreative = z.object({
	headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
	descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(4),
	final_urls: z.array(z.string().url()).min(1).max(20),
	path1: z.string().trim().max(15).optional(),
	path2: z.string().trim().max(15).optional(),
});

const LinkedinLocale = z.object({
	country: z.string().regex(/^[A-Z]{2}$/),
	language: z.string().regex(/^[a-z]{2}$/),
});

const LinkedinTargetingClause = z.object({
	facet_urn: z.string().regex(/^urn:li:adTargetingFacet:[A-Za-z0-9_-]+$/),
	values: z
		.array(z.string().regex(/^urn:li:[A-Za-z][A-Za-z0-9_-]*:.+$/))
		.min(1)
		.max(100),
});

export const LinkedinCampaignProviderSettings = z.object({
	locale: LinkedinLocale,
	include: z.array(LinkedinTargetingClause).min(1).max(100),
	exclude: z.array(LinkedinTargetingClause).max(100).optional(),
	associated_entity: z.string().regex(/^urn:li:(organization|person):.+$/),
	political_intent: z.enum(["POLITICAL", "NOT_POLITICAL", "NOT_DECLARED"]),
	format: z
		.enum(["SINGLE_IMAGE", "SINGLE_VIDEO", "CAROUSEL", "DOCUMENT"])
		.optional(),
	cost_type: z.enum(["CPC", "CPM", "CPV"]).default("CPC"),
	unit_cost_cents: PositiveMinorUnits,
	audience_expansion_enabled: z.boolean().default(false),
	offsite_delivery_enabled: z.boolean().default(false),
});

const LinkedinCreativeProviderSettings = z.object({
	content_reference: z
		.string()
		.regex(/^urn:li:(share|ugcPost|adInMailContent):.+$/),
});

/**
 * Pinterest API v5 request fields used by Relay's non-CBO campaign/ad-group
 * plan. Official schemas: CampaignCreateRequest, AdGroupCreateRequest,
 * TargetingSpec, and AdCreateRequest.
 * https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
 */
export const PinterestCampaignProviderSettings = z.object({
	bid_in_micro_currency: z.number().int().positive(),
	billable_event: z.enum(["CLICKTHROUGH", "IMPRESSION", "VIDEO_V_50_MRC"]),
	bid_strategy_type: z
		.enum(["AUTOMATIC_BID", "MAX_BID", "TARGET_AVG"])
		.default("AUTOMATIC_BID"),
	placement_group: z.enum(["ALL", "SEARCH", "BROWSE", "OTHER"]).default("ALL"),
	auto_targeting_enabled: z.boolean().default(false),
	geo_codes: z
		.array(z.string().trim().min(1).max(64))
		.min(1)
		.max(100)
		.optional(),
	locale_codes: z
		.array(z.string().regex(/^[a-z]{2}$/))
		.min(1)
		.max(24)
		.optional(),
});

const PinterestCreativeProviderSettings = z.object({
	/** Required for standalone ads; boosts use the selected post's Pin ID. */
	pin_id: PositiveProviderId.optional(),
	creative_type: z.enum(["REGULAR", "VIDEO", "CAROUSEL", "COLLECTION", "IDEA"]),
	destination_url: z.string().url().optional(),
});

/**
 * TikTok Marketing API v1.3 fields from Campaign Create, Ad Group Create,
 * Ad Create, and Identities. Schedule values are advertiser-timezone values,
 * so callers provide the provider-native string instead of Relay guessing.
 * https://business-api.tiktok.com/portal/docs?id=1739499616346114
 * https://business-api.tiktok.com/portal/docs?id=1739953377508354
 */
const TikTokSchedule = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

export const TikTokCampaignProviderSettings = z.object({
	location_ids: z.array(PositiveProviderId).min(1).max(1000),
	optimization_goal: z.enum([
		"CLICK",
		"PAGE_VISIT",
		"REACH",
		"ENGAGED_VIEW",
		"ENGAGED_VIEW_FIFTEEN",
	]),
	billing_event: z.enum(["CPC", "CPM", "CPV"]),
	promotion_type: z.literal("WEBSITE").default("WEBSITE"),
	placement_type: z
		.literal("PLACEMENT_TYPE_NORMAL")
		.default("PLACEMENT_TYPE_NORMAL"),
	placements: z
		.array(z.literal("PLACEMENT_TIKTOK"))
		.min(1)
		.max(1)
		.default(["PLACEMENT_TIKTOK"]),
	budget_mode: z.enum(["BUDGET_MODE_DAY", "BUDGET_MODE_TOTAL"]),
	schedule_type: z.enum(["SCHEDULE_START_END", "SCHEDULE_FROM_NOW"]),
	schedule_start_time: TikTokSchedule,
	schedule_end_time: TikTokSchedule.optional(),
	gender: z
		.enum(["GENDER_UNLIMITED", "GENDER_MALE", "GENDER_FEMALE"])
		.default("GENDER_UNLIMITED"),
	age_groups: z
		.array(z.string().trim().min(1).max(32))
		.min(1)
		.max(20)
		.optional(),
	languages: z.array(PositiveProviderId).min(1).max(100).optional(),
	interest_category_ids: z
		.array(PositiveProviderId)
		.min(1)
		.max(1000)
		.optional(),
	audience_ids: z.array(PositiveProviderId).min(1).max(1000).optional(),
	excluded_audience_ids: z
		.array(PositiveProviderId)
		.min(1)
		.max(1000)
		.optional(),
	operating_systems: z
		.array(z.enum(["ANDROID", "IOS"]))
		.min(1)
		.max(2)
		.optional(),
	bid_type: z
		.enum(["BID_TYPE_NO_BID", "BID_TYPE_CUSTOM"])
		.default("BID_TYPE_NO_BID"),
	bid_price: z.number().positive().optional(),
});

const TikTokCreativeProviderSettings = z.object({
	identity_type: z.enum([
		"CUSTOMIZED_USER",
		"AUTH_CODE",
		"TT_USER",
		"BC_AUTH_TT",
	]),
	identity_id: z.string().trim().min(1).max(255),
	identity_authorized_bc_id: PositiveProviderId.optional(),
	/** Required for standalone Spark Ads; boosts use the selected post ID. */
	tiktok_item_id: PositiveProviderId.optional(),
	/** Provider media ID returned by TikTok's video upload endpoint. */
	video_id: z.string().trim().min(1).max(255).optional(),
	display_name: z.string().trim().min(1).max(100).optional(),
	ad_text: z.string().trim().min(1).max(100).optional(),
	call_to_action: z.string().trim().min(1).max(100).optional(),
	landing_page_url: z.string().url().optional(),
});

/**
 * X Ads API v12 campaign/line-item and promoted-Tweet parameters.
 * https://docs.x.com/x-ads-api/campaign-management/reference
 */
export const TwitterCampaignProviderSettings = z.object({
	funding_instrument_id: z.string().trim().min(1).max(64),
	objective: z.enum(["REACH", "WEBSITE_CLICKS", "ENGAGEMENTS", "VIDEO_VIEWS"]),
	placements: z
		.enum(["ALL_ON_TWITTER", "TWITTER_TIMELINE"])
		.default("ALL_ON_TWITTER"),
	bid_strategy: z.enum(["AUTO", "MAX", "TARGET"]).default("AUTO"),
	bid_amount_local_micro: z.number().int().positive().optional(),
	/** X documents that omitting targeting delivers worldwide. Require consent. */
	allow_worldwide_targeting: z.literal(true),
});

const TwitterCreativeProviderSettings = z.object({
	/** Required for standalone ads; boosts use the selected post's Tweet ID. */
	tweet_id: PositiveProviderId.optional(),
});

/**
 * Stable provider-options envelope. Each provider owns one discriminated
 * variant so adding fields never changes another provider's request contract.
 * Provider variants stay disjoint so adding fields cannot silently change a
 * different provider's public request contract.
 */
export const AdCampaignProviderOptionsSchema = z.discriminatedUnion(
	"platform",
	[
		z.object({
			platform: z.literal("google"),
			settings: GoogleCampaignProviderSettings,
		}),
		z.object({
			platform: z.literal("linkedin"),
			settings: LinkedinCampaignProviderSettings,
		}),
		z.object({
			platform: z.literal("pinterest"),
			settings: PinterestCampaignProviderSettings,
		}),
		z.object({
			platform: z.literal("tiktok"),
			settings: TikTokCampaignProviderSettings,
		}),
		z.object({
			platform: z.literal("twitter"),
			settings: TwitterCampaignProviderSettings,
		}),
	],
);

export const AdCreateProviderOptionsSchema = z.discriminatedUnion("platform", [
	z.object({
		platform: z.literal("google"),
		campaign: GoogleCampaignProviderSettings.optional(),
		creative: GoogleResponsiveSearchCreative,
	}),
	z.object({
		platform: z.literal("linkedin"),
		campaign: LinkedinCampaignProviderSettings.optional(),
		creative: LinkedinCreativeProviderSettings,
	}),
	z.object({
		platform: z.literal("pinterest"),
		campaign: PinterestCampaignProviderSettings.optional(),
		creative: PinterestCreativeProviderSettings,
	}),
	z.object({
		platform: z.literal("tiktok"),
		campaign: TikTokCampaignProviderSettings.optional(),
		creative: TikTokCreativeProviderSettings,
	}),
	z.object({
		platform: z.literal("twitter"),
		campaign: TwitterCampaignProviderSettings.optional(),
		creative: TwitterCreativeProviderSettings,
	}),
]);

export type AdCampaignProviderOptions = z.infer<
	typeof AdCampaignProviderOptionsSchema
>;
export type AdCreateProviderOptions = z.infer<
	typeof AdCreateProviderOptionsSchema
>;
