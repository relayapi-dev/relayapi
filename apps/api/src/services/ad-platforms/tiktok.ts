// TikTok for Business Marketing API v1.3 adapter.
// Official sources (TikTok Business API documentation portal):
// - Advertiser authorization and advertiser information:
//   https://ads.tiktok.com/gateway/docs/index?doc_id=1738373164380162&language=ENGLISH
// - Campaign/ad-group/ad operations and reporting index:
//   https://business-api.tiktok.com/gateway/docs/index?doc_id=1735713875563521&language=ENGLISH

import { API_VERSIONS } from "../../config/api-versions";
import type {
	AdCampaignProviderOptions,
	AdCreateProviderOptions,
} from "../../schemas/ad-provider-options";
import {
	arrayValue,
	fetchProviderJson,
	numberValue,
	objectValue,
	stringValue,
} from "./http";
import type {
	AdPlatformAdapter,
	AdPlatformCapabilities,
	AdProviderCredentials,
	AdProviderMutationPreflight,
	AdProviderMutationState,
	AdTargeting,
	CampaignProviderMutationState,
	CreateAdSetParams,
	CreateCampaignParams,
	CreateCreativeParams,
	CreatePlatformAdParams,
	ExternalAdData,
	ExternalAdSyncResult,
	FindCreatedAdObjectParams,
	PlatformAdAccount,
	UpdateAdParams,
	UpdateCampaignParams,
} from "./types";
import { AdPlatformError } from "./types";
import { unsupportedAdAdapter } from "./unsupported";

const TIKTOK_ADS_BASE = `https://business-api.tiktok.com/open_api/${API_VERSIONS.tiktok_business}`;
const MAX_LIST_PAGES = 20;

const capabilities: AdPlatformCapabilities = {
	apiVersion: API_VERSIONS.tiktok_business,
	authProtocol: "oauth2",
	requiresDedicatedConnection: true,
	// TikTok Marketing API access is app/advertiser permission gated. Do not
	// invent OAuth scope strings: the connection's advertiser allowlist and the
	// provider response are the runtime authority for the implemented reads.
	requiredScopes: [],
	operations: {
		account_discovery: { state: "supported" },
		external_sync: { state: "supported" },
		analytics: {
			state: "unsupported",
			reason:
				"TikTok integrated and asynchronous report jobs need a durable provider-job projection before analytics is exposed",
		},
		campaign_create: { state: "supported" },
		ad_create: { state: "supported" },
		boost: {
			state: "supported",
			reason:
				"Runtime authority still requires approved Marketing API advertiser access and an authorized Spark identity",
		},
		mutation: { state: "supported" },
		targeting_search: {
			state: "requires_approval",
			reason:
				"TikTok interest-category and keyword tools are permission and market dependent",
		},
		audience_discovery: {
			state: "requires_approval",
			reason: "TikTok DMP custom audiences require separate app permissions",
		},
		audience_create: {
			state: "requires_approval",
			reason: "TikTok DMP custom audiences require separate app permissions",
		},
		audience_upload: {
			state: "requires_approval",
			reason: "TikTok DMP file upload requires separate app permissions",
		},
	},
	objectives: ["awareness", "traffic", "video_views"],
	formats: ["video", "spark_post"],
	officialDocs: [
		"https://business-api.tiktok.com/gateway/docs/index?doc_id=1735713875563521&language=ENGLISH",
		"https://business-api.tiktok.com/portal/docs?id=1739318962329602",
		"https://business-api.tiktok.com/portal/docs?id=1739499616346114",
		"https://business-api.tiktok.com/portal/docs?id=1739953377508354",
	],
};

function credentialsOrThrow(
	accessToken: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	if (!accessToken) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"TikTok Ads requires a dedicated TikTok for Business advertiser connection",
		);
	}
	return {
		...(credentials ?? { metadata: {} }),
		accessToken,
		metadata: credentials?.metadata ?? {},
	};
}

function tiktokHeaders(credentials: AdProviderCredentials): HeadersInit {
	return { "Access-Token": credentials.accessToken };
}

function tiktokEnvelope(value: unknown): Record<string, unknown> {
	const envelope = objectValue(value);
	if (!envelope) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"TikTok Ads returned a non-object response",
		);
	}
	const code = Number(envelope.code ?? 0);
	if (code !== 0) {
		throw new AdPlatformError(
			// TikTok returns business errors inside HTTP 200 envelopes. Error-code
			// meanings are product/version dependent, so preserve the exact code and
			// avoid guessing auth or retry semantics that the response did not prove.
			"PROVIDER_API_ERROR",
			stringValue(envelope.message) ?? `TikTok Ads API error ${code}`,
			{
				code,
				requestId: stringValue(envelope.request_id),
			},
		);
	}
	return objectValue(envelope.data) ?? {};
}

function advertiserIds(metadata: Record<string, unknown>): string[] {
	return arrayValue(metadata.advertiser_ids)
		.map((value) =>
			typeof value === "number" ? String(value) : stringValue(value),
		)
		.filter((value): value is string => Boolean(value))
		.slice(0, 100);
}

async function tiktokList(
	credentials: AdProviderCredentials,
	path: "campaign/get" | "adgroup/get" | "ad/get",
	advertiserId: string,
	filtering?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	for (let page = 1; page <= MAX_LIST_PAGES; page++) {
		const url = new URL(`${TIKTOK_ADS_BASE}/${path}/`);
		url.searchParams.set("advertiser_id", advertiserId);
		url.searchParams.set("page", String(page));
		url.searchParams.set("page_size", "1000");
		if (filtering) url.searchParams.set("filtering", JSON.stringify(filtering));
		const { data } = await fetchProviderJson<unknown>({
			platform: "tiktok",
			url: url.toString(),
			init: { headers: tiktokHeaders(credentials) },
		});
		const payload = tiktokEnvelope(data);
		for (const item of arrayValue(payload.list)) {
			const object = objectValue(item);
			if (object) items.push(object);
		}
		const pageInfo = objectValue(payload.page_info);
		const totalPage = Number(pageInfo?.total_page ?? page);
		if (!Number.isFinite(totalPage) || page >= totalPage) break;
	}
	return items;
}

type TikTokCampaignSettings = Extract<
	AdCampaignProviderOptions,
	{ platform: "tiktok" }
>["settings"];
type TikTokCreativeSettings = Extract<
	AdCreateProviderOptions,
	{ platform: "tiktok" }
>["creative"];

function invalidTikTok(message: string): never {
	throw new AdPlatformError("INVALID_PROVIDER_OPTIONS", message);
}

function tiktokCampaignSettings(
	options: CreateCampaignParams["providerOptions"],
): TikTokCampaignSettings {
	if (options?.platform !== "tiktok") {
		return invalidTikTok(
			"TikTok campaign creation requires TikTok provider_options",
		);
	}
	const settings = "settings" in options ? options.settings : options.campaign;
	if (!settings) {
		return invalidTikTok(
			"TikTok campaign settings are required when creating a campaign",
		);
	}
	return settings;
}

function tiktokCreativeSettings(
	options: CreateCreativeParams["providerOptions"],
): TikTokCreativeSettings {
	if (options?.platform !== "tiktok") {
		return invalidTikTok(
			"TikTok ad creation requires TikTok creative provider_options",
		);
	}
	return options.creative;
}

function tiktokAdvertiserId(credentials: AdProviderCredentials): string {
	if (!credentials.providerAdAccountId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"TikTok mutation requires the provider advertiser ID",
		);
	}
	return credentials.providerAdAccountId;
}

/**
 * TikTok Marketing API reports business errors in a JSON envelope even on an
 * HTTP 200. Every write is therefore accepted only when `code` is zero.
 * Official v1.3 operations and body field names:
 * POST /campaign/create/, /adgroup/create/, /ad/create/,
 * /campaign/status/update/, /adgroup/status/update/, /ad/status/update/.
 * https://github.com/tiktok/tiktok-business-api-sdk/tree/main/js_sdk/docs
 */
async function tiktokWrite(
	credentials: AdProviderCredentials,
	path: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { data } = await fetchProviderJson<unknown>({
		platform: "tiktok",
		url: `${TIKTOK_ADS_BASE}/${path}/`,
		init: {
			method: "POST",
			headers: {
				...tiktokHeaders(credentials),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	});
	return tiktokEnvelope(data);
}

function tiktokObjectiveType(
	objective: string,
): "REACH" | "TRAFFIC" | "VIDEO_VIEWS" {
	if (objective === "awareness") return "REACH";
	if (objective === "traffic") return "TRAFFIC";
	if (objective === "video_views") return "VIDEO_VIEWS";
	return invalidTikTok(
		"TikTok supports awareness, traffic, and video_views through this write adapter",
	);
}

function validateTikTokGoal(
	objective: string,
	settings: TikTokCampaignSettings,
): void {
	const valid =
		(objective === "awareness" &&
			settings.optimization_goal === "REACH" &&
			settings.billing_event === "CPM") ||
		(objective === "traffic" &&
			(settings.optimization_goal === "CLICK" ||
				settings.optimization_goal === "PAGE_VISIT") &&
			settings.billing_event === "CPC") ||
		(objective === "video_views" &&
			(settings.optimization_goal === "ENGAGED_VIEW" ||
				settings.optimization_goal === "ENGAGED_VIEW_FIFTEEN") &&
			settings.billing_event === "CPV");
	if (!valid) {
		invalidTikTok(
			"TikTok optimization_goal and billing_event must match the selected objective",
		);
	}
	if (
		settings.schedule_type === "SCHEDULE_START_END" &&
		!settings.schedule_end_time
	) {
		invalidTikTok("TikTok SCHEDULE_START_END requires schedule_end_time");
	}
	if (settings.bid_type === "BID_TYPE_CUSTOM" && !settings.bid_price) {
		invalidTikTok("TikTok BID_TYPE_CUSTOM requires bid_price");
	}
}

function assertTikTokBudget(
	params: Pick<
		CreateCampaignParams,
		"dailyBudgetCents" | "lifetimeBudgetCents"
	>,
	settings: TikTokCampaignSettings,
): number {
	if (
		(params.dailyBudgetCents === undefined) ===
		(params.lifetimeBudgetCents === undefined)
	) {
		return invalidTikTok(
			"TikTok requires exactly one of daily_budget_cents or lifetime_budget_cents",
		);
	}
	if (
		params.dailyBudgetCents !== undefined &&
		settings.budget_mode !== "BUDGET_MODE_DAY"
	) {
		return invalidTikTok("TikTok daily budgets require BUDGET_MODE_DAY");
	}
	if (
		params.lifetimeBudgetCents !== undefined &&
		settings.budget_mode !== "BUDGET_MODE_TOTAL"
	) {
		return invalidTikTok("TikTok lifetime budgets require BUDGET_MODE_TOTAL");
	}
	return (params.dailyBudgetCents ?? params.lifetimeBudgetCents ?? 0) / 100;
}

function buildTikTokTargeting(
	targeting?: AdTargeting,
): Record<string, unknown> {
	if (targeting?.platformSpecific) {
		invalidTikTok("TikTok does not accept untyped targeting.platform_specific");
	}
	if (targeting?.locations?.length) {
		invalidTikTok(
			"TikTok geography requires provider location_ids in provider_options",
		);
	}
	if (targeting?.placements?.length) {
		invalidTikTok(
			"Use TikTok provider_options.campaign.placements instead of generic placements",
		);
	}
	if (targeting?.ageMin !== undefined || targeting?.ageMax !== undefined) {
		invalidTikTok(
			"TikTok age targeting uses provider age_groups in provider_options",
		);
	}
	const fields: Record<string, unknown> = {};
	if (targeting?.interests?.length)
		fields.interest_category_ids = targeting.interests.map((value) => value.id);
	if (targeting?.customAudiences?.length)
		fields.audience_ids = targeting.customAudiences;
	if (targeting?.excludedAudiences?.length)
		fields.excluded_audience_ids = targeting.excludedAudiences;
	if (targeting?.languages?.length) {
		if (targeting.languages.some((value) => !/^\d+$/.test(value))) {
			invalidTikTok("TikTok language targeting requires provider language IDs");
		}
		fields.languages = targeting.languages;
	}
	const genders = targeting?.genders?.filter((value) => value !== "all") ?? [];
	if (genders.length === 1) {
		fields.gender = genders[0] === "male" ? "GENDER_MALE" : "GENDER_FEMALE";
	} else if (genders.length > 1) {
		fields.gender = "GENDER_UNLIMITED";
	}
	return fields;
}

function mergeTikTokTargeting(
	settings: TikTokCampaignSettings,
	targeting?: AdTargeting,
): Record<string, unknown> {
	return {
		location_ids: settings.location_ids,
		gender: settings.gender,
		age_groups: settings.age_groups,
		languages: settings.languages,
		interest_category_ids: settings.interest_category_ids,
		audience_ids: settings.audience_ids,
		excluded_audience_ids: settings.excluded_audience_ids,
		operating_systems: settings.operating_systems,
		...buildTikTokTargeting(targeting),
	};
}

async function tiktokEntity(
	credentials: AdProviderCredentials,
	kind: "campaign" | "adgroup" | "ad",
	id: string,
): Promise<Record<string, unknown> | null> {
	const advertiserId = tiktokAdvertiserId(credentials);
	const field =
		kind === "campaign"
			? "campaign_ids"
			: kind === "adgroup"
				? "adgroup_ids"
				: "ad_ids";
	const rows = await tiktokList(credentials, `${kind}/get`, advertiserId, {
		[field]: [id],
	});
	const idField = `${kind}_id`;
	return rows.find((row) => String(row[idField]) === id) ?? null;
}

function requiredTikTokId(value: unknown, description: string): string {
	const id =
		stringValue(value) ??
		(typeof value === "number" && Number.isSafeInteger(value)
			? String(value)
			: undefined);
	if (!id) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`TikTok did not return ${description}`,
		);
	}
	return id;
}

function tiktokStatus(value: unknown): string {
	const status = stringValue(value)?.toUpperCase() ?? "";
	if (status.includes("ENABLE") || status.includes("ACTIVE")) return "active";
	if (status.includes("DISABLE") || status.includes("PAUSE")) return "paused";
	if (status.includes("DELETE")) return "cancelled";
	if (status.includes("REVIEW")) return "pending_review";
	if (status.includes("REJECT")) return "rejected";
	return "draft";
}

function tiktokMutationStatus(value: unknown): string | undefined {
	const status = stringValue(value)?.toUpperCase();
	if (!status) return undefined;
	if (status.includes("DELETE")) return "DELETED";
	if (status.includes("ENABLE") || status.includes("ACTIVE")) return "ACTIVE";
	if (status.includes("DISABLE") || status.includes("PAUSE")) return "PAUSED";
	return status;
}

function tiktokAccountStatus(value: unknown): "active" | "disabled" {
	const status = stringValue(value)?.toUpperCase() ?? "";
	if (
		status.includes("DISABLE") ||
		status.includes("SUSPEND") ||
		status.includes("CANCEL") ||
		status.includes("CLOSE")
	) {
		return "disabled";
	}
	return "active";
}

const base = unsupportedAdAdapter("tiktok", capabilities);

export const tiktokAdAdapter: AdPlatformAdapter = {
	...base,
	validateCreateCampaign(params: CreateCampaignParams): void {
		const relayObjective =
			params.objective ??
			invalidTikTok("TikTok campaign creation requires objective");
		const settings = tiktokCampaignSettings(params.providerOptions);
		tiktokObjectiveType(relayObjective);
		validateTikTokGoal(relayObjective, settings);
		assertTikTokBudget(params, settings);
	},
	validateCreateAd(params): void {
		const creative = tiktokCreativeSettings(params.providerOptions);
		const itemId = params.platformPostId ?? creative.tiktok_item_id;
		if (Boolean(itemId) === Boolean(creative.video_id)) {
			invalidTikTok(
				"TikTok ads require exactly one Spark tiktok_item_id or uploaded video_id",
			);
		}
		if (itemId && creative.identity_type === "CUSTOMIZED_USER") {
			invalidTikTok(
				"TikTok Spark Ads require AUTH_CODE, TT_USER, or BC_AUTH_TT identity",
			);
		}
		if (creative.video_id && creative.identity_type !== "CUSTOMIZED_USER") {
			invalidTikTok(
				"TikTok non-Spark uploaded video ads require CUSTOMIZED_USER identity",
			);
		}
		if (
			creative.identity_type === "BC_AUTH_TT" &&
			!creative.identity_authorized_bc_id
		) {
			invalidTikTok(
				"TikTok BC_AUTH_TT identity requires identity_authorized_bc_id",
			);
		}
		if (creative.video_id && !creative.display_name) {
			invalidTikTok(
				"TikTok non-Spark video ads require provider_options.creative.display_name",
			);
		}
		if (!params.campaignId) {
			const relayObjective =
				params.objective ??
				invalidTikTok("TikTok campaign creation requires objective");
			const settings = tiktokCampaignSettings(params.providerOptions);
			tiktokObjectiveType(relayObjective);
			validateTikTokGoal(relayObjective, settings);
			assertTikTokBudget(params, settings);
			buildTikTokTargeting(
				(params as typeof params & { targeting?: AdTargeting }).targeting,
			);
		}
	},
	validateMutation(payload: AdProviderMutationPreflight): void {
		if (
			payload.kind === "update_ad" &&
			payload.changes?.name !== undefined &&
			payload.changes.status !== undefined
		) {
			invalidTikTok(
				"TikTok ad name and status use separate provider endpoints; send them as separate idempotent mutations",
			);
		}
		if (
			payload.kind === "update_ad" &&
			payload.changes?.dailyBudgetCents !== undefined &&
			payload.changes.lifetimeBudgetCents !== undefined
		) {
			invalidTikTok("TikTok cannot set daily and lifetime budgets together");
		}
	},
	canonicalizeTargeting(targeting: AdTargeting): Record<string, unknown> {
		return buildTikTokTargeting(targeting);
	},
	creation: {
		...base.creation,
		coalescesCreativeAndAd: true,
		async createCampaign(
			accessToken: string,
			adAccountId: string,
			params: CreateCampaignParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			credentials.providerAdAccountId = adAccountId;
			tiktokCampaignSettings(params.providerOptions);
			const data = await tiktokWrite(credentials, "campaign/create", {
				advertiser_id: adAccountId,
				campaign_name: params.name,
				objective_type: tiktokObjectiveType(
					params.objective ??
						invalidTikTok("TikTok campaign creation requires objective"),
				),
				operation_status: "DISABLE",
			});
			return requiredTikTokId(data.campaign_id, "a campaign ID");
		},
		async createAdSet(
			accessToken: string,
			adAccountId: string,
			params: CreateAdSetParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			credentials.providerAdAccountId = adAccountId;
			const settings = tiktokCampaignSettings(params.providerOptions);
			validateTikTokGoal(params.objective, settings);
			const budget = assertTikTokBudget(params, settings);
			const data = await tiktokWrite(credentials, "adgroup/create", {
				advertiser_id: adAccountId,
				campaign_id: params.campaignId,
				adgroup_name: params.name,
				promotion_type:
					params.objective === "traffic" ? settings.promotion_type : undefined,
				placement_type: settings.placement_type,
				placements: settings.placements,
				...mergeTikTokTargeting(settings, params.targeting),
				budget_mode: settings.budget_mode,
				budget,
				schedule_type: settings.schedule_type,
				schedule_start_time: settings.schedule_start_time,
				schedule_end_time: settings.schedule_end_time,
				optimization_goal: settings.optimization_goal,
				bid_type: settings.bid_type,
				bid_price: settings.bid_price,
				billing_event: settings.billing_event,
				pacing: "PACING_MODE_SMOOTH",
				operation_status: "DISABLE",
			});
			return requiredTikTokId(data.adgroup_id, "an ad group ID");
		},
		async createCreativeAndAd(
			accessToken: string,
			adAccountId: string,
			creative: CreateCreativeParams,
			ad: CreatePlatformAdParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<{ creativeId: string; adId: string }> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			credentials.providerAdAccountId = adAccountId;
			const settings = tiktokCreativeSettings(creative.providerOptions);
			const itemId = creative.platformPostId ?? settings.tiktok_item_id;
			const creativeId = itemId ?? settings.video_id;
			if (!creativeId || Boolean(itemId) === Boolean(settings.video_id)) {
				return invalidTikTok(
					"TikTok ads require exactly one Spark post ID or uploaded video ID",
				);
			}
			if (itemId && settings.identity_type === "CUSTOMIZED_USER") {
				return invalidTikTok(
					"TikTok Spark Ads require AUTH_CODE, TT_USER, or BC_AUTH_TT identity",
				);
			}
			if (settings.video_id && settings.identity_type !== "CUSTOMIZED_USER") {
				return invalidTikTok(
					"TikTok non-Spark ads require CUSTOMIZED_USER identity",
				);
			}
			if (
				settings.identity_type === "BC_AUTH_TT" &&
				!settings.identity_authorized_bc_id
			) {
				return invalidTikTok(
					"TikTok BC_AUTH_TT identity requires identity_authorized_bc_id",
				);
			}
			const data = await tiktokWrite(credentials, "ad/create", {
				advertiser_id: adAccountId,
				adgroup_id: ad.adSetId,
				creatives: [
					{
						ad_name: ad.name,
						ad_text: settings.ad_text ?? creative.body,
						call_to_action: settings.call_to_action ?? creative.callToAction,
						landing_page_url: settings.landing_page_url ?? creative.linkUrl,
						identity_type: settings.identity_type,
						identity_id: settings.identity_id,
						identity_authorized_bc_id: settings.identity_authorized_bc_id,
						tiktok_item_id: itemId,
						video_id: settings.video_id,
						display_name: settings.display_name,
						operation_status: ad.active ? "ENABLE" : "DISABLE",
					},
				],
			});
			const ids = arrayValue(data.ad_ids);
			if (ids.length !== 1) {
				throw new AdPlatformError(
					"PROVIDER_PROTOCOL_ERROR",
					"TikTok did not acknowledge exactly one created ad",
				);
			}
			return {
				creativeId,
				adId: requiredTikTokId(ids[0], "an ad ID"),
			};
		},
		async findCreatedCreativeAndAd(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<{ creativeId: string; adId: string } | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const rows = await tiktokList(credentials, "ad/get", adAccountId);
			const row = rows.find((item) =>
				stringValue(item.ad_name)?.includes(params.marker),
			);
			const adId = row?.ad_id === undefined ? undefined : String(row.ad_id);
			const creativeId =
				stringValue(row?.tiktok_item_id) ?? stringValue(row?.video_id);
			return adId && creativeId ? { creativeId, adId } : null;
		},
		async findCreatedObject(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const kind = params.phase === "campaign" ? "campaign" : "adgroup";
			const rows = await tiktokList(
				credentials,
				kind === "campaign" ? "campaign/get" : "adgroup/get",
				adAccountId,
			);
			const row = rows.find((item) =>
				stringValue(item[`${kind}_name`])?.includes(params.marker),
			);
			return row?.[`${kind}_id`] === undefined
				? null
				: String(row[`${kind}_id`]);
		},
		async activateBoost(
			accessToken: string,
			platformCampaignId: string,
			platformAdSetId: string,
			refreshAccessTokenBeforeAdSet?: () => Promise<string>,
			providerCredentials?: AdProviderCredentials,
		): Promise<void> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const advertiserId = tiktokAdvertiserId(credentials);
			await tiktokWrite(credentials, "campaign/status/update", {
				advertiser_id: advertiserId,
				campaign_ids: [platformCampaignId],
				operation_status: "ENABLE",
			});
			const refreshedToken = refreshAccessTokenBeforeAdSet
				? await refreshAccessTokenBeforeAdSet()
				: accessToken;
			await tiktokWrite(
				{ ...credentials, accessToken: refreshedToken },
				"adgroup/status/update",
				{
					advertiser_id: advertiserId,
					adgroup_ids: [platformAdSetId],
					operation_status: "ENABLE",
					allow_partial_success: false,
				},
			);
		},
		async isBoostActivated(
			accessToken: string,
			platformCampaignId: string,
			platformAdSetId: string,
			providerCredentials?: AdProviderCredentials,
		): Promise<boolean> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const [campaign, adGroup] = await Promise.all([
				tiktokEntity(credentials, "campaign", platformCampaignId),
				tiktokEntity(credentials, "adgroup", platformAdSetId),
			]);
			return (
				campaign?.operation_status === "ENABLE" &&
				adGroup?.operation_status === "ENABLE"
			);
		},
	},
	async updateAd(
		accessToken: string,
		platformAdId: string,
		params: UpdateAdParams,
		_refreshAccessTokenBeforeAdSet?: () => Promise<string>,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const advertiserId = tiktokAdvertiserId(credentials);
		const ad = await tiktokEntity(credentials, "ad", platformAdId);
		if (!ad) {
			throw new AdPlatformError("NOT_FOUND", "TikTok ad was not found");
		}
		const adGroupId = requiredTikTokId(ad.adgroup_id, "the parent ad group ID");
		if (params.name !== undefined) {
			await tiktokWrite(credentials, "ad/update", {
				advertiser_id: advertiserId,
				adgroup_id: adGroupId,
				patch_update: true,
				creatives: [{ ad_id: platformAdId, ad_name: params.name }],
			});
		}
		if (params.status !== undefined) {
			await tiktokWrite(credentials, "ad/status/update", {
				advertiser_id: advertiserId,
				ad_ids: [platformAdId],
				operation_status: params.status === "active" ? "ENABLE" : "DISABLE",
			});
		}
		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined ||
			params.targeting !== undefined
		) {
			await tiktokWrite(credentials, "adgroup/update", {
				advertiser_id: advertiserId,
				adgroup_id: adGroupId,
				budget:
					params.dailyBudgetCents !== undefined
						? params.dailyBudgetCents / 100
						: params.lifetimeBudgetCents !== undefined
							? params.lifetimeBudgetCents / 100
							: undefined,
				...buildTikTokTargeting(params.targeting),
			});
		}
	},
	async updateCampaign(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string | undefined,
		params: UpdateCampaignParams,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const advertiserId = tiktokAdvertiserId(credentials);
		if (params.name !== undefined) {
			await tiktokWrite(credentials, "campaign/update", {
				advertiser_id: advertiserId,
				campaign_id: platformCampaignId,
				campaign_name: params.name,
			});
		}
		if (
			params.dailyBudgetCents === undefined &&
			params.lifetimeBudgetCents === undefined
		) {
			return;
		}
		if (!platformAdSetId) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"TikTok budget updates require the campaign ad group ID",
			);
		}
		await tiktokWrite(credentials, "adgroup/update", {
			advertiser_id: advertiserId,
			adgroup_id: platformAdSetId,
			budget:
				(params.dailyBudgetCents ?? params.lifetimeBudgetCents ?? 0) / 100,
		});
	},
	async inspectAdMutation(
		accessToken: string,
		platformAdId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<AdProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const ad = await tiktokEntity(credentials, "ad", platformAdId);
		if (!ad) return { exists: false };
		const adGroupId =
			ad.adgroup_id === undefined ? undefined : String(ad.adgroup_id);
		const adGroup = adGroupId
			? await tiktokEntity(credentials, "adgroup", adGroupId)
			: null;
		const budget = numberValue(adGroup?.budget);
		const budgetMode = stringValue(adGroup?.budget_mode);
		return {
			exists: true,
			name: stringValue(ad.ad_name),
			status: tiktokMutationStatus(ad.operation_status ?? ad.secondary_status),
			adSetId: adGroupId,
			dailyBudgetCents:
				budgetMode === "BUDGET_MODE_DAY" && budget !== undefined
					? Math.round(budget * 100)
					: null,
			lifetimeBudgetCents:
				budgetMode === "BUDGET_MODE_TOTAL" && budget !== undefined
					? Math.round(budget * 100)
					: null,
			targeting: adGroup
				? {
						location_ids: adGroup.location_ids,
						gender: adGroup.gender,
						age_groups: adGroup.age_groups,
						languages: adGroup.languages,
						interest_category_ids: adGroup.interest_category_ids,
						audience_ids: adGroup.audience_ids,
						excluded_audience_ids: adGroup.excluded_audience_ids,
					}
				: undefined,
		};
	},
	async inspectCampaignMutation(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId?: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<CampaignProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const campaign = await tiktokEntity(
			credentials,
			"campaign",
			platformCampaignId,
		);
		if (!campaign) return { exists: false };
		const adGroup = platformAdSetId
			? await tiktokEntity(credentials, "adgroup", platformAdSetId)
			: null;
		const budget = numberValue(adGroup?.budget);
		const budgetMode = stringValue(adGroup?.budget_mode);
		return {
			exists: true,
			name: stringValue(campaign.campaign_name),
			status: tiktokMutationStatus(
				campaign.operation_status ?? campaign.secondary_status,
			),
			adSetStatus: adGroup
				? tiktokMutationStatus(
						adGroup.operation_status ?? adGroup.secondary_status,
					)
				: undefined,
			dailyBudgetCents:
				budgetMode === "BUDGET_MODE_DAY" && budget !== undefined
					? Math.round(budget * 100)
					: null,
			lifetimeBudgetCents:
				budgetMode === "BUDGET_MODE_TOTAL" && budget !== undefined
					? Math.round(budget * 100)
					: null,
		};
	},
	async pauseAd(accessToken, platformAdId, providerCredentials): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await tiktokWrite(credentials, "ad/status/update", {
			advertiser_id: tiktokAdvertiserId(credentials),
			ad_ids: [platformAdId],
			operation_status: "DISABLE",
		});
	},
	async resumeAd(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await tiktokWrite(credentials, "ad/status/update", {
			advertiser_id: tiktokAdvertiserId(credentials),
			ad_ids: [platformAdId],
			operation_status: "ENABLE",
		});
	},
	async cancelAd(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await tiktokWrite(credentials, "ad/status/update", {
			advertiser_id: tiktokAdvertiserId(credentials),
			ad_ids: [platformAdId],
			operation_status: "DELETE",
		});
	},
	async pauseCampaign(
		accessToken,
		platformCampaignId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await tiktokWrite(credentials, "campaign/status/update", {
			advertiser_id: tiktokAdvertiserId(credentials),
			campaign_ids: [platformCampaignId],
			operation_status: "DISABLE",
		});
	},
	async resumeCampaign(
		accessToken,
		platformCampaignId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await tiktokWrite(credentials, "campaign/status/update", {
			advertiser_id: tiktokAdvertiserId(credentials),
			campaign_ids: [platformCampaignId],
			operation_status: "ENABLE",
		});
	},
	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const ids = advertiserIds(credentials.metadata);
		if (ids.length === 0) {
			throw new AdPlatformError(
				"ADS_CONNECTION_SETUP_INCOMPLETE",
				"The TikTok Business OAuth exchange did not persist its authorized advertiser_ids",
			);
		}
		const url = new URL(`${TIKTOK_ADS_BASE}/advertiser/info/`);
		url.searchParams.set("advertiser_ids", JSON.stringify(ids));
		url.searchParams.set(
			"fields",
			JSON.stringify([
				"advertiser_id",
				"name",
				"currency",
				"timezone",
				"status",
			]),
		);
		const { data } = await fetchProviderJson<unknown>({
			platform: "tiktok",
			url: url.toString(),
			init: { headers: tiktokHeaders(credentials) },
		});
		const payload = tiktokEnvelope(data);
		return arrayValue(payload.list).flatMap((item) => {
			const advertiser = objectValue(item);
			const id =
				stringValue(advertiser?.advertiser_id) ??
				(advertiser?.advertiser_id === undefined
					? undefined
					: String(advertiser.advertiser_id));
			if (!id) return [];
			return [
				{
					id,
					name: stringValue(advertiser?.name) ?? `TikTok Ads ${id}`,
					currency: stringValue(advertiser?.currency),
					timezone: stringValue(advertiser?.timezone),
					status: tiktokAccountStatus(advertiser?.status),
					metadata: { provider_status: stringValue(advertiser?.status) },
				},
			];
		});
	},

	async syncExternalAds(
		accessToken: string,
		adAccountId: string,
		_since?: Date,
		providerCredentials?: AdProviderCredentials,
	): Promise<ExternalAdSyncResult> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const [campaignRows, adGroupRows, adRows] = await Promise.all([
			tiktokList(credentials, "campaign/get", adAccountId),
			tiktokList(credentials, "adgroup/get", adAccountId),
			tiktokList(credentials, "ad/get", adAccountId),
		]);
		const campaigns = new Map(
			campaignRows.map((row) => [String(row.campaign_id), row] as const),
		);
		const adGroups = new Map(
			adGroupRows.map((row) => [String(row.adgroup_id), row] as const),
		);
		const ads: ExternalAdData[] = [];
		for (const row of adRows) {
			const adId = row.ad_id === undefined ? undefined : String(row.ad_id);
			const campaignId =
				row.campaign_id === undefined ? undefined : String(row.campaign_id);
			const adGroupId =
				row.adgroup_id === undefined ? undefined : String(row.adgroup_id);
			if (!adId || !campaignId) continue;
			const campaign = campaigns.get(campaignId);
			const adGroup = adGroupId ? adGroups.get(adGroupId) : undefined;
			ads.push({
				platformCampaignId: campaignId,
				campaignName:
					stringValue(campaign?.campaign_name) ?? `Campaign ${campaignId}`,
				platformAdSetId: adGroupId,
				adSetName: stringValue(adGroup?.adgroup_name),
				platformAdId: adId,
				adName: stringValue(row.ad_name) ?? `Ad ${adId}`,
				status: tiktokStatus(row.secondary_status ?? row.operation_status),
				objective: "video_views",
				creative: {
					body: stringValue(row.ad_text),
					callToAction: stringValue(row.call_to_action),
					linkUrl: stringValue(row.landing_page_url),
				},
			});
		}
		return { ads, totalFound: ads.length };
	},
};
