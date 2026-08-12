import { z } from "@hono/zod-openapi";
import { AdPlatformEnum } from "./ads";

export const ADVANCED_AD_FEATURES = [
	"lead_forms",
	"lead_inbox",
	"lead_promotion",
	"conversions",
	"messaging_experiences",
	"report_jobs",
	"forecasts",
	"keyword_ideas",
	"creative_assets",
	"catalogs",
	"product_sets",
] as const;

export const AdvancedAdFeatureEnum = z.enum(ADVANCED_AD_FEATURES);
export const AdvancedAdCapabilityStateEnum = z.enum([
	"supported",
	"requires_approval",
	"unsupported",
]);

export const AdvancedAdCapability = z.object({
	state: AdvancedAdCapabilityStateEnum,
	reason: z.string().optional(),
	required_scopes: z.array(z.string()).default([]),
	required_program: z.string().optional(),
	checked_at: z.string().datetime().nullable().default(null),
});

export const AdvancedAdAccountCapabilitiesResponse = z.object({
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	capabilities: z.record(AdvancedAdFeatureEnum, AdvancedAdCapability),
});

export const AdvancedAdAccountParams = z.object({
	ad_account_id: z.string().min(1),
});

export const AdvancedAdIdParams = z.object({ id: z.string().min(1) });

export const AdvancedAdListQuery = z.object({
	ad_account_id: z.string().min(1),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

const JsonObject = z.record(z.string(), z.unknown());

// Lead forms are provider projections. Creation links a form Relay has already
// observed; provider-native create/edit remains capability gated per account.
export const CreateAdLeadFormProjectionBody = z.object({
	ad_account_id: z.string().min(1),
	provider_form_id: z.string().trim().min(1).max(512),
	name: z.string().trim().min(1).max(512).optional(),
	status: z.enum(["draft", "active", "archived", "unknown"]).default("unknown"),
	configuration: JsonObject.default({}),
});

export const AdLeadFormResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	provider_form_id: z.string(),
	name: z.string().nullable(),
	status: z.enum(["draft", "active", "archived", "unknown"]),
	configuration: JsonObject,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AdLeadFormListResponse = z.object({
	data: z.array(AdLeadFormResponse),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

export const AdLeadStatusEnum = z.enum(["new", "promoted", "dismissed"]);

export const AdLeadResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	ad_account_id: z.string(),
	lead_form_id: z.string().nullable(),
	platform: AdPlatformEnum,
	provider_lead_id: z.string(),
	status: AdLeadStatusEnum,
	data: JsonObject,
	contact_id: z.string().nullable(),
	provider_created_at: z.string().datetime().nullable(),
	expires_at: z.string().datetime(),
	created_at: z.string().datetime(),
});

export const AdLeadListQuery = AdvancedAdListQuery.extend({
	status: AdLeadStatusEnum.optional(),
	lead_form_id: z.string().optional(),
});

export const AdLeadListResponse = z.object({
	data: z.array(AdLeadResponse),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

export const PromoteAdLeadBody = z.object({
	name_field: z.string().min(1).max(255).optional(),
	email_field: z.string().min(1).max(255).optional(),
	phone_field: z.string().min(1).max(255).optional(),
	tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
	metadata_fields: z.array(z.string().min(1).max(255)).max(100).default([]),
});

export const PromoteAdLeadResponse = z.object({
	lead: AdLeadResponse,
	contact_id: z.string(),
	created: z.boolean(),
});

export const CreateAdConversionRuleBody = z.object({
	ad_account_id: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	event_name: z.string().trim().min(1).max(255),
	provider_destination_id: z.string().trim().min(1).max(512),
	configuration: JsonObject.default({}),
	enabled: z.boolean().default(true),
});

export const AdConversionRuleResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	name: z.string(),
	event_name: z.string(),
	provider_destination_id: z.string(),
	configuration: JsonObject,
	enabled: z.boolean(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const CreateAdConversionEventBody = z.object({
	conversion_rule_id: z.string().min(1),
	event_id: z.string().trim().min(1).max(512),
	occurred_at: z.string().datetime({ offset: true }),
	value_micros: z.string().regex(/^\d+$/).optional(),
	currency: z
		.string()
		.regex(/^[A-Za-z]{3}$/)
		.transform((value) => value.toUpperCase())
		.optional(),
	identifiers: JsonObject.default({}),
	properties: JsonObject.default({}),
});

export const AdDurableOperationStatusEnum = z.enum([
	"pending",
	"processing",
	"request_may_have_been_sent",
	"unknown",
	"completed",
	"failed",
	"cancelled",
]);

export const AdConversionEventResponse = z.object({
	id: z.string(),
	conversion_rule_id: z.string(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	event_id: z.string(),
	status: AdDurableOperationStatusEnum,
	provider_event_id: z.string().nullable(),
	attempts: z.number().int().nonnegative(),
	last_error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

const MetaMessagingConfiguration = z.object({
	platform: z.literal("meta"),
	destination: z.enum(["messenger", "instagram_direct", "whatsapp"]),
	page_id: z.string().min(1),
	welcome_message: z.string().max(1000).optional(),
});

const GoogleMessagingConfiguration = z.object({
	platform: z.literal("google"),
	provider: z.string().min(1).max(255),
	provider_account_id: z.string().min(1).max(512),
});

const TikTokMessagingConfiguration = z.object({
	platform: z.literal("tiktok"),
	identity_id: z.string().min(1).max(512),
	message_scenario: z.string().min(1).max(255),
});

const LinkedInMessagingConfiguration = z.object({
	platform: z.literal("linkedin"),
	conversation_ad_id: z.string().min(1).max(512),
});

const TwitterMessagingConfiguration = z.object({
	platform: z.literal("twitter"),
	conversation_card_id: z.string().min(1).max(512),
});

export const AdMessagingConfiguration = z.discriminatedUnion("platform", [
	MetaMessagingConfiguration,
	GoogleMessagingConfiguration,
	TikTokMessagingConfiguration,
	LinkedInMessagingConfiguration,
	TwitterMessagingConfiguration,
]);

export const CreateAdMessagingExperienceBody = z.object({
	ad_account_id: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	provider_resource_id: z.string().trim().min(1).max(512),
	configuration: AdMessagingConfiguration,
});

export const AdAdvancedResourceResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	kind: z.enum([
		"messaging_experience",
		"creative_asset",
		"catalog",
		"product_set",
	]),
	provider_resource_id: z.string().nullable(),
	parent_id: z.string().nullable(),
	name: z.string().nullable(),
	status: z.string(),
	configuration: JsonObject,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const CreateAdCreativeAssetBody = z
	.object({
		ad_account_id: z.string().min(1),
		name: z.string().trim().min(1).max(255).optional(),
		media_id: z.string().min(1).optional(),
		provider_resource_id: z.string().trim().min(1).max(512).optional(),
		asset_type: z.enum(["image", "video", "text", "document", "other"]),
		configuration: JsonObject.default({}),
	})
	.refine((value) => value.media_id || value.provider_resource_id, {
		message: "media_id or provider_resource_id is required",
	});

export const CreateAdCatalogBody = z.object({
	ad_account_id: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	provider_resource_id: z.string().trim().min(1).max(512),
	configuration: JsonObject.default({}),
});

export const CreateAdProductSetBody = z.object({
	ad_account_id: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	provider_resource_id: z.string().trim().min(1).max(512).optional(),
	filter: JsonObject,
});

const WholeHour = z
	.string()
	.datetime({ offset: true })
	.refine((value) => {
		const date = new Date(value);
		return (
			date.getUTCMinutes() === 0 &&
			date.getUTCSeconds() === 0 &&
			date.getUTCMilliseconds() === 0
		);
	}, "Timestamp must be aligned to a whole hour");

const TikTokReportRequest = z.object({
	platform: z.literal("tiktok"),
	report_type: z.enum(["BASIC", "AUDIENCE", "CATALOG"]).default("BASIC"),
	data_level: z.enum([
		"AUCTION_AD",
		"AUCTION_ADGROUP",
		"AUCTION_CAMPAIGN",
		"AUCTION_ADVERTISER",
	]),
	dimensions: z.array(z.string().min(1).max(128)).min(1).max(20),
	metrics: z.array(z.string().min(1).max(128)).min(1).max(200),
	start_date: z.string().date(),
	end_date: z.string().date(),
	filters: z.array(JsonObject).max(20).default([]),
	// Relay normalizes report artifacts into bounded rows. Keep the public
	// contract to the provider's CSV download mode; XLSX ZIP expansion has no
	// streaming contract in Workers and is intentionally not advertised.
	output_format: z.literal("CSV_DOWNLOAD").default("CSV_DOWNLOAD"),
});

const TwitterReportRequest = z.object({
	platform: z.literal("twitter"),
	entity: z.enum([
		"ACCOUNT",
		"CAMPAIGN",
		"FUNDING_INSTRUMENT",
		"LINE_ITEM",
		"PROMOTED_ACCOUNT",
		"PROMOTED_TWEET",
	]),
	entity_ids: z.array(z.string().min(1).max(128)).min(1).max(20),
	start_time: WholeHour,
	end_time: WholeHour,
	granularity: z.enum(["DAY", "HOUR", "TOTAL"]),
	placement: z.enum(["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"]),
	metric_groups: z
		.array(
			z.enum([
				"BILLING",
				"ENGAGEMENT",
				"LIFE_TIME_VALUE_MOBILE_CONVERSION",
				"MOBILE_CONVERSION",
				"VIDEO",
				"WEB_CONVERSION",
			]),
		)
		.min(1)
		.max(6),
	segmentation_type: z.string().min(1).max(128).optional(),
});

const LinkedInReportRequest = z.object({
	platform: z.literal("linkedin"),
	pivot: z.enum([
		"COMPANY",
		"ACCOUNT",
		"SHARE",
		"CAMPAIGN",
		"CREATIVE",
		"CAMPAIGN_GROUP",
		"CONVERSION",
		"CONVERSATION_NODE",
		"CONVERSATION_NODE_OPTION_INDEX",
		"SERVING_LOCATION",
		"EVENT_STAGE",
		"MEMBER_COMPANY",
		"MEMBER_INDUSTRY",
		"MEMBER_SENIORITY",
		"MEMBER_JOB_TITLE",
		"MEMBER_JOB_FUNCTION",
		"MEMBER_COUNTRY_V2",
		"MEMBER_REGION",
		"MEMBER_COUNTY",
		"MEMBER_SKILLS",
		"MEMBER_DEGREE",
		"MEMBER_FIELD_OF_STUDY",
	]),
	start_date: z.string().date(),
	end_date: z.string().date(),
	time_granularity: z.enum(["ALL", "DAILY", "MONTHLY", "YEARLY"]),
	fields: z.array(z.string().min(1).max(128)).min(1).max(20),
});

function hasDuplicates(values: readonly string[]): boolean {
	return new Set(values).size !== values.length;
}

export const AdReportProviderRequest = z
	.discriminatedUnion("platform", [
		TikTokReportRequest,
		TwitterReportRequest,
		LinkedInReportRequest,
	])
	.superRefine((request, context) => {
		if (request.platform === "tiktok") {
			if (request.start_date > request.end_date) {
				context.addIssue({
					code: "custom",
					path: ["end_date"],
					message: "end_date must be on or after start_date",
				});
			}
			for (const field of ["dimensions", "metrics"] as const) {
				if (hasDuplicates(request[field])) {
					context.addIssue({
						code: "custom",
						path: [field],
						message: `${field} must not contain duplicates`,
					});
				}
			}
			return;
		}

		if (request.platform === "twitter") {
			const start = new Date(request.start_time).valueOf();
			const end = new Date(request.end_time).valueOf();
			const maximumDays = request.segmentation_type ? 45 : 90;
			if (end <= start || end - start > maximumDays * 24 * 60 * 60 * 1000) {
				context.addIssue({
					code: "custom",
					path: ["end_time"],
					message: `end_time must be after start_time and within ${maximumDays} days`,
				});
			}
			if (hasDuplicates(request.entity_ids)) {
				context.addIssue({
					code: "custom",
					path: ["entity_ids"],
					message: "entity_ids must not contain duplicates",
				});
			}
			if (
				request.metric_groups.includes("MOBILE_CONVERSION") &&
				request.metric_groups.length > 1
			) {
				context.addIssue({
					code: "custom",
					path: ["metric_groups"],
					message: "MOBILE_CONVERSION must be requested separately",
				});
			}
			return;
		}

		if (request.end_date <= request.start_date) {
			context.addIssue({
				code: "custom",
				path: ["end_date"],
				message: "end_date must be after start_date",
			});
		}
		if (hasDuplicates(request.fields)) {
			context.addIssue({
				code: "custom",
				path: ["fields"],
				message: "fields must not contain duplicates",
			});
		}
	});

export const CreateAdReportBody = z.object({
	ad_account_id: z.string().min(1),
	request: AdReportProviderRequest,
});

export const AdReportJobStatusEnum = z.enum([
	"pending",
	"submitting",
	"provider_pending",
	"downloading",
	"completed",
	"failed",
	"unknown",
	"cancelled",
]);

export const AdReportJobResponse = z.object({
	id: z.string(),
	workspace_id: z.string().nullable(),
	ad_account_id: z.string(),
	platform: AdPlatformEnum,
	status: AdReportJobStatusEnum,
	request: AdReportProviderRequest,
	provider_job_id: z.string().nullable(),
	row_count: z.number().int().nonnegative().nullable(),
	result_expires_at: z.string().datetime().nullable(),
	last_error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	completed_at: z.string().datetime().nullable(),
});

export const AdReportResultRow = z.object({
	dimensions: JsonObject,
	metrics: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
});

export const AdReportResultsResponse = z.object({
	data: z.array(AdReportResultRow),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

export const AdPlanningRequest = z.object({
	ad_account_id: z.string().min(1),
	seed_keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
	language: z.string().min(1).max(32).optional(),
	geo_targets: z.array(z.string().min(1).max(128)).max(20).default([]),
	provider_options: JsonObject.default({}),
});

export const AdPlanningResponse = z.object({
	platform: AdPlatformEnum,
	kind: z.enum(["forecast", "keyword_ideas"]),
	data: z.array(JsonObject).max(1000),
});
