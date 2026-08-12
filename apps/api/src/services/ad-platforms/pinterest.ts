// Pinterest API v5 Ads adapter.
// Official sources:
// - Machine-readable API description: https://github.com/pinterest/api-description/tree/main/v5
// - Campaign/ad-group creation: https://developers.pinterest.com/docs/work-with-ads/create-campaigns-and-ad-groups/
// - Ads management: https://developers.pinterest.com/docs/work-with-ads/managing-ads/
// - Rate limits: https://developers.pinterest.com/docs/reference/rate-limits/

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
	AdMetricPoint,
	AdMetricsWithDemographics,
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
	DateRange,
	ExternalAdData,
	ExternalAdSyncResult,
	FindCreatedAdObjectParams,
	PlatformAdAccount,
	PlatformAudience,
	UpdateAdParams,
	UpdateCampaignParams,
} from "./types";
import { AdPlatformError } from "./types";
import { unsupportedAdAdapter } from "./unsupported";

const PINTEREST_BASE = `https://api.pinterest.com/${API_VERSIONS.pinterest_ads}`;
const MAX_LIST_PAGES = 20;

const capabilities: AdPlatformCapabilities = {
	apiVersion: API_VERSIONS.pinterest_ads,
	authProtocol: "oauth2",
	requiresDedicatedConnection: true,
	requiredScopes: ["ads:read", "ads:write"],
	operations: {
		account_discovery: { state: "supported" },
		external_sync: { state: "supported" },
		analytics: { state: "supported" },
		campaign_create: { state: "supported" },
		ad_create: { state: "supported" },
		boost: { state: "supported" },
		mutation: { state: "supported" },
		targeting_search: {
			state: "unsupported",
			reason:
				"Pinterest exposes targeting resources/interest trees, not the current generic fuzzy-interest contract",
		},
		audience_discovery: {
			state: "requires_approval",
			reason:
				"Pinterest audience APIs require production access and are not present in the full Sandbox surface",
		},
		audience_create: {
			state: "requires_approval",
			reason:
				"Pinterest customer, website, and actalike audiences require production access and provider-specific options",
		},
		audience_upload: {
			state: "requires_approval",
			reason: "Pinterest audience upload requires approved production access",
		},
	},
	objectives: ["awareness", "traffic", "video_views"],
	formats: ["pin", "video_pin", "existing_pin"],
	officialDocs: [
		"https://github.com/pinterest/api-description/tree/main/v5",
		"https://developers.pinterest.com/docs/work-with-ads/create-campaigns-and-ad-groups/",
		"https://developers.pinterest.com/docs/work-with-ads/managing-ads/",
		"https://developers.pinterest.com/docs/reference/rate-limits/",
	],
};

function credentialsOrThrow(
	accessToken: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	if (!accessToken) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"Pinterest Ads requires a dedicated OAuth connection with ads scopes",
		);
	}
	return {
		...(credentials ?? { metadata: {} }),
		accessToken,
		metadata: credentials?.metadata ?? {},
	};
}

function pinterestHeaders(credentials: AdProviderCredentials): HeadersInit {
	return { Authorization: `Bearer ${credentials.accessToken}` };
}

async function pinterestList(
	credentials: AdProviderCredentials,
	path: string,
	params: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	let bookmark: string | undefined;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const url = new URL(`${PINTEREST_BASE}${path}`);
		url.searchParams.set("page_size", "100");
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		if (bookmark) url.searchParams.set("bookmark", bookmark);
		const { data } = await fetchProviderJson<unknown>({
			platform: "pinterest",
			url: url.toString(),
			init: { headers: pinterestHeaders(credentials) },
		});
		const envelope = objectValue(data);
		if (!envelope) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Pinterest returned a non-object list response",
			);
		}
		for (const item of arrayValue(envelope.items)) {
			const object = objectValue(item);
			if (object) items.push(object);
		}
		bookmark = stringValue(envelope.bookmark);
		if (!bookmark) break;
	}
	return items;
}

type PinterestCampaignSettings = Extract<
	AdCampaignProviderOptions,
	{ platform: "pinterest" }
>["settings"];
type PinterestCreativeSettings = Extract<
	AdCreateProviderOptions,
	{ platform: "pinterest" }
>["creative"];

function invalidPinterest(message: string): never {
	throw new AdPlatformError("INVALID_PROVIDER_OPTIONS", message);
}

function pinterestCampaignSettings(
	options: CreateCampaignParams["providerOptions"],
): PinterestCampaignSettings {
	if (options?.platform !== "pinterest") {
		return invalidPinterest(
			"Pinterest campaign creation requires provider_options for Pinterest",
		);
	}
	const settings = "settings" in options ? options.settings : options.campaign;
	if (!settings) {
		return invalidPinterest(
			"Pinterest campaign settings are required when creating a campaign",
		);
	}
	return settings;
}

function pinterestCreativeSettings(
	options: CreateCreativeParams["providerOptions"],
): PinterestCreativeSettings {
	if (options?.platform !== "pinterest") {
		return invalidPinterest(
			"Pinterest ad creation requires Pinterest creative provider_options",
		);
	}
	return options.creative;
}

function pinterestAdAccountId(credentials: AdProviderCredentials): string {
	if (!credentials.providerAdAccountId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Pinterest mutation requires the provider ad account ID",
		);
	}
	return credentials.providerAdAccountId;
}

/**
 * Pinterest v5 batch write endpoints accept an array and return one result per
 * item. Relay sends exactly one item and treats any exception as a failed
 * provider effect; it never infers success from HTTP 200 alone.
 * https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
 * Operations: campaigns/create|update, ad_groups/create|update, ads/create|update.
 */
async function pinterestBatchWrite(
	credentials: AdProviderCredentials,
	path: "/campaigns" | "/ad_groups" | "/ads",
	method: "POST" | "PATCH",
	item: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const adAccountId = pinterestAdAccountId(credentials);
	const { data } = await fetchProviderJson<unknown>({
		platform: "pinterest",
		url: `${PINTEREST_BASE}/ad_accounts/${encodeURIComponent(adAccountId)}${path}`,
		init: {
			method,
			headers: {
				...pinterestHeaders(credentials),
				"Content-Type": "application/json",
			},
			body: JSON.stringify([item]),
		},
	});
	const rows = arrayValue(objectValue(data)?.items);
	if (rows.length !== 1) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"Pinterest returned an invalid single-item batch acknowledgement",
		);
	}
	const row = objectValue(rows[0]);
	const exceptions = arrayValue(row?.exceptions);
	const result = objectValue(row?.data);
	if (!row || exceptions.length > 0 || !result) {
		throw new AdPlatformError(
			"PROVIDER_API_ERROR",
			"Pinterest rejected the batch write item",
			{ exceptions: row?.exceptions },
		);
	}
	return result;
}

async function pinterestEntity(
	credentials: AdProviderCredentials,
	kind: "campaigns" | "ad_groups" | "ads",
	id: string,
): Promise<Record<string, unknown> | null> {
	const adAccountId = pinterestAdAccountId(credentials);
	const rows = await pinterestList(
		credentials,
		`/ad_accounts/${encodeURIComponent(adAccountId)}/${kind}`,
		{ [`${kind === "ad_groups" ? "ad_group" : kind.slice(0, -1)}_ids`]: id },
	);
	return rows.find((row) => stringValue(row.id) === id) ?? null;
}

function pinterestMicros(cents: number): number {
	return cents * 10_000;
}

function pinterestSeconds(value?: string): number | undefined {
	if (!value) return undefined;
	const milliseconds = new Date(value).getTime();
	if (!Number.isFinite(milliseconds)) {
		return invalidPinterest(
			"Pinterest schedule values must be valid timestamps",
		);
	}
	return Math.floor(milliseconds / 1000);
}

function pinterestObjectiveType(
	objective: string,
): "AWARENESS" | "CONSIDERATION" | "VIDEO_COMPLETION" {
	switch (objective) {
		case "awareness":
			return "AWARENESS";
		case "traffic":
			return "CONSIDERATION";
		case "video_views":
			return "VIDEO_COMPLETION";
		default:
			return invalidPinterest(
				"Pinterest supports awareness, traffic, and video_views through this write adapter",
			);
	}
}

function pinterestBillableEvent(
	objective: string,
): "IMPRESSION" | "CLICKTHROUGH" | "VIDEO_V_50_MRC" {
	if (objective === "awareness") return "IMPRESSION" as const;
	if (objective === "traffic") return "CLICKTHROUGH" as const;
	if (objective === "video_views") return "VIDEO_V_50_MRC" as const;
	return invalidPinterest("Unsupported Pinterest objective");
}

function assertOnePinterestBudget(params: {
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
}): void {
	if (
		(params.dailyBudgetCents === undefined) ===
		(params.lifetimeBudgetCents === undefined)
	) {
		invalidPinterest(
			"Pinterest requires exactly one of daily_budget_cents or lifetime_budget_cents",
		);
	}
}

function buildPinterestTargeting(
	targeting: AdTargeting | undefined,
	settings?: PinterestCampaignSettings,
	requireGeography = true,
): Record<string, unknown> {
	if (targeting?.platformSpecific) {
		invalidPinterest(
			"Pinterest does not accept untyped targeting.platform_specific fields",
		);
	}
	if (
		targeting?.locations?.some(
			(location) =>
				(location.cities?.length ?? 0) > 0 ||
				location.radiusMiles !== undefined,
		)
	) {
		invalidPinterest(
			"Pinterest city and radius targeting require provider geo codes; use provider_options.campaign.geo_codes",
		);
	}
	if (targeting?.placements?.length) {
		invalidPinterest(
			"Use Pinterest provider_options.campaign.placement_group instead of generic placements",
		);
	}
	const countries = (targeting?.locations ?? []).flatMap(
		(location) => location.countries ?? [],
	);
	const geoCodes = settings?.geo_codes ?? [];
	if (requireGeography && countries.length === 0 && geoCodes.length === 0) {
		invalidPinterest(
			"Pinterest requires at least one country or provider geo code; Relay will not default paid targeting",
		);
	}
	const spec: Record<string, unknown> = {};
	if (countries.length > 0) spec.LOCATION = [...new Set(countries)];
	if (geoCodes.length > 0) spec.GEO = [...new Set(geoCodes)];
	if (targeting?.ageMin !== undefined || targeting?.ageMax !== undefined) {
		if (
			targeting.ageMin === undefined ||
			targeting.ageMax === undefined ||
			targeting.ageMin < 18 ||
			targeting.ageMax > 65 ||
			targeting.ageMin > targeting.ageMax
		) {
			invalidPinterest(
				"Pinterest MINIMUM_AGE and MAXIMUM_AGE must be supplied together between 18 and 65",
			);
		}
		spec.MINIMUM_AGE = String(targeting.ageMin);
		spec.MAXIMUM_AGE = String(targeting.ageMax);
	}
	const genders = (targeting?.genders ?? []).filter(
		(gender): gender is "male" | "female" => gender !== "all",
	);
	if (genders.length > 0) spec.GENDER = [...new Set(genders)];
	if (targeting?.interests?.length)
		spec.INTEREST = targeting.interests.map((interest) => interest.id);
	if (targeting?.customAudiences?.length)
		spec.AUDIENCE_INCLUDE = targeting.customAudiences;
	if (targeting?.excludedAudiences?.length)
		spec.AUDIENCE_EXCLUDE = targeting.excludedAudiences;
	const locales = settings?.locale_codes ?? targeting?.languages;
	if (locales?.length) {
		if (locales.some((locale) => !/^[a-z]{2}$/.test(locale))) {
			invalidPinterest("Pinterest locale targeting uses ISO 639-1 codes");
		}
		spec.LOCALE = [...new Set(locales)];
	}
	return spec;
}

function requirePinterestId(value: unknown, description: string): string {
	const id = stringValue(value);
	if (!id) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`Pinterest did not return ${description}`,
		);
	}
	return id;
}

function pinterestStatus(value: unknown): string {
	switch (stringValue(value)?.toUpperCase()) {
		case "ACTIVE":
			return "active";
		case "PAUSED":
			return "paused";
		case "ARCHIVED":
		case "DELETED":
			return "cancelled";
		case "PENDING":
			return "pending_review";
		case "REJECTED":
			return "rejected";
		default:
			return "draft";
	}
}

function pinterestMutationStatus(value: unknown): string | undefined {
	const status = stringValue(value)?.toUpperCase();
	if (status === "ARCHIVED" || status === "DELETED") return "DELETED";
	return status;
}

function pinterestObjective(value: unknown): string {
	const objective = stringValue(value)?.toUpperCase() ?? "";
	if (objective.includes("VIDEO")) return "video_views";
	if (objective.includes("CONVERSION") || objective.includes("CATALOG")) {
		return "conversions";
	}
	if (objective.includes("AWARENESS")) return "awareness";
	return "traffic";
}

const base = unsupportedAdAdapter("pinterest", capabilities);

export const pinterestAdAdapter: AdPlatformAdapter = {
	...base,
	validateCreateCampaign(params: CreateCampaignParams): void {
		const relayObjective =
			params.objective ??
			invalidPinterest("Pinterest campaign creation requires objective");
		const settings = pinterestCampaignSettings(params.providerOptions);
		assertOnePinterestBudget(params);
		if (params.lifetimeBudgetCents !== undefined && !params.endDate) {
			invalidPinterest("Pinterest lifetime budgets require end_date");
		}
		const objective = pinterestObjectiveType(relayObjective);
		if (settings.billable_event !== pinterestBillableEvent(relayObjective)) {
			invalidPinterest(
				"Pinterest billable_event must match the selected Relay objective",
			);
		}
		if (
			objective === "VIDEO_COMPLETION" &&
			settings.bid_strategy_type !== "AUTOMATIC_BID"
		) {
			invalidPinterest(
				"Pinterest Video Completion campaigns require AUTOMATIC_BID",
			);
		}
		buildPinterestTargeting(undefined, settings);
	},
	validateCreateAd(params): void {
		const creative = pinterestCreativeSettings(params.providerOptions);
		if (!creative.pin_id && !params.platformPostId) {
			invalidPinterest(
				"Pinterest standalone ads require provider_options.creative.pin_id",
			);
		}
		if (!params.campaignId) {
			const relayObjective =
				params.objective ??
				invalidPinterest("Pinterest campaign creation requires objective");
			const settings = pinterestCampaignSettings(params.providerOptions);
			assertOnePinterestBudget(params);
			if (params.lifetimeBudgetCents !== undefined && !params.endDate) {
				invalidPinterest("Pinterest lifetime budgets require end_date");
			}
			const objective = pinterestObjectiveType(relayObjective);
			if (settings.billable_event !== pinterestBillableEvent(relayObjective)) {
				invalidPinterest(
					"Pinterest billable_event must match the selected Relay objective",
				);
			}
			if (
				objective === "VIDEO_COMPLETION" &&
				settings.bid_strategy_type !== "AUTOMATIC_BID"
			) {
				invalidPinterest(
					"Pinterest Video Completion campaigns require AUTOMATIC_BID",
				);
			}
			buildPinterestTargeting(
				(params as typeof params & { targeting?: AdTargeting }).targeting,
				settings,
			);
		}
	},
	validateMutation(payload: AdProviderMutationPreflight): void {
		if (
			payload.kind === "update_ad" &&
			payload.changes?.dailyBudgetCents !== undefined &&
			payload.changes.lifetimeBudgetCents !== undefined
		) {
			invalidPinterest(
				"Pinterest cannot set daily and lifetime ad-group budgets together",
			);
		}
		if (payload.kind === "update_ad" && payload.changes?.targeting) {
			buildPinterestTargeting(payload.changes.targeting);
		}
	},
	canonicalizeTargeting(targeting: AdTargeting): Record<string, unknown> {
		return buildPinterestTargeting(targeting, undefined, false);
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
			pinterestCampaignSettings(params.providerOptions);
			const result = await pinterestBatchWrite(
				credentials,
				"/campaigns",
				"POST",
				{
					ad_account_id: adAccountId,
					name: params.name,
					objective_type: pinterestObjectiveType(
						params.objective ??
							invalidPinterest(
								"Pinterest campaign creation requires objective",
							),
					),
					is_campaign_budget_optimization: false,
					status: "PAUSED",
					start_time: pinterestSeconds(params.startDate),
					end_time: pinterestSeconds(params.endDate),
				},
			);
			return requirePinterestId(result.id, "a campaign ID");
		},
		async createAdSet(
			accessToken: string,
			adAccountId: string,
			params: CreateAdSetParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			credentials.providerAdAccountId = adAccountId;
			const settings = pinterestCampaignSettings(params.providerOptions);
			if (
				settings.billable_event !== pinterestBillableEvent(params.objective)
			) {
				return invalidPinterest(
					"Pinterest billable_event must match the campaign objective",
				);
			}
			assertOnePinterestBudget(params);
			const budgetCents =
				params.dailyBudgetCents ?? params.lifetimeBudgetCents ?? 0;
			const result = await pinterestBatchWrite(
				credentials,
				"/ad_groups",
				"POST",
				{
					campaign_id: params.campaignId,
					name: params.name,
					billable_event: settings.billable_event,
					bid_in_micro_currency: settings.bid_in_micro_currency,
					bid_strategy_type: settings.bid_strategy_type,
					budget_in_micro_currency: pinterestMicros(budgetCents),
					budget_type:
						params.lifetimeBudgetCents === undefined ? "DAILY" : "LIFETIME",
					placement_group: settings.placement_group,
					auto_targeting_enabled: settings.auto_targeting_enabled,
					targeting_spec: buildPinterestTargeting(params.targeting, settings),
					start_time: pinterestSeconds(params.startDate),
					end_time: pinterestSeconds(params.endDate),
					status: "PAUSED",
				},
			);
			return requirePinterestId(result.id, "an ad group ID");
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
			const settings = pinterestCreativeSettings(creative.providerOptions);
			const pinId = creative.platformPostId ?? settings.pin_id;
			if (!pinId) {
				return invalidPinterest(
					"Pinterest ads require a Pin ID from the boosted post or provider_options",
				);
			}
			const result = await pinterestBatchWrite(credentials, "/ads", "POST", {
				ad_group_id: ad.adSetId,
				pin_id: pinId,
				creative_type: settings.creative_type,
				name: ad.name,
				destination_url: settings.destination_url ?? creative.linkUrl,
				status: ad.active ? "ACTIVE" : "PAUSED",
			});
			return {
				creativeId: pinId,
				adId: requirePinterestId(result.id, "an ad ID"),
			};
		},
		async findCreatedCreativeAndAd(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<{ creativeId: string; adId: string } | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const ads = await pinterestList(
				credentials,
				`/ad_accounts/${encodeURIComponent(adAccountId)}/ads`,
			);
			const found = ads.find((row) =>
				stringValue(row.name)?.includes(params.marker),
			);
			const adId = stringValue(found?.id);
			const pinId = stringValue(found?.pin_id);
			return adId && pinId ? { creativeId: pinId, adId } : null;
		},
		async findCreatedObject(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const kind = params.phase === "campaign" ? "campaigns" : "ad_groups";
			const rows = await pinterestList(
				credentials,
				`/ad_accounts/${encodeURIComponent(adAccountId)}/${kind}`,
			);
			return (
				rows
					.find((row) => stringValue(row.name)?.includes(params.marker))
					?.id?.toString() ?? null
			);
		},
		async activateBoost(
			accessToken: string,
			platformCampaignId: string,
			platformAdSetId: string,
			refreshAccessTokenBeforeAdSet?: () => Promise<string>,
			providerCredentials?: AdProviderCredentials,
		): Promise<void> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			await pinterestBatchWrite(credentials, "/campaigns", "PATCH", {
				id: platformCampaignId,
				status: "ACTIVE",
			});
			const refreshedToken = refreshAccessTokenBeforeAdSet
				? await refreshAccessTokenBeforeAdSet()
				: accessToken;
			await pinterestBatchWrite(
				{ ...credentials, accessToken: refreshedToken },
				"/ad_groups",
				"PATCH",
				{ id: platformAdSetId, status: "ACTIVE" },
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
				pinterestEntity(credentials, "campaigns", platformCampaignId),
				pinterestEntity(credentials, "ad_groups", platformAdSetId),
			]);
			return campaign?.status === "ACTIVE" && adGroup?.status === "ACTIVE";
		},
	},
	async updateAd(
		accessToken: string,
		platformAdId: string,
		params: UpdateAdParams,
		refreshAccessTokenBeforeAdSet?: () => Promise<string>,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		if (params.name !== undefined || params.status !== undefined) {
			await pinterestBatchWrite(credentials, "/ads", "PATCH", {
				id: platformAdId,
				name: params.name,
				status:
					params.status === undefined
						? undefined
						: params.status === "active"
							? "ACTIVE"
							: "PAUSED",
			});
		}
		if (
			params.dailyBudgetCents === undefined &&
			params.lifetimeBudgetCents === undefined &&
			params.targeting === undefined
		) {
			return;
		}
		const ad = await pinterestEntity(credentials, "ads", platformAdId);
		const adGroupId = stringValue(ad?.ad_group_id);
		if (!adGroupId) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Pinterest ad did not include its parent ad group",
			);
		}
		const refreshedToken = refreshAccessTokenBeforeAdSet
			? await refreshAccessTokenBeforeAdSet()
			: accessToken;
		const adGroupPatch: Record<string, unknown> = { id: adGroupId };
		if (params.dailyBudgetCents !== undefined) {
			adGroupPatch.budget_in_micro_currency = pinterestMicros(
				params.dailyBudgetCents,
			);
			adGroupPatch.budget_type = "DAILY";
		}
		if (params.lifetimeBudgetCents !== undefined) {
			adGroupPatch.budget_in_micro_currency = pinterestMicros(
				params.lifetimeBudgetCents,
			);
			adGroupPatch.budget_type = "LIFETIME";
		}
		if (params.targeting !== undefined) {
			adGroupPatch.targeting_spec = buildPinterestTargeting(params.targeting);
		}
		await pinterestBatchWrite(
			{ ...credentials, accessToken: refreshedToken },
			"/ad_groups",
			"PATCH",
			adGroupPatch,
		);
	},
	async updateCampaign(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string | undefined,
		params: UpdateCampaignParams,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		if (params.name !== undefined) {
			await pinterestBatchWrite(credentials, "/campaigns", "PATCH", {
				id: platformCampaignId,
				name: params.name,
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
				"Pinterest budget updates require the campaign ad group ID",
			);
		}
		const budget = params.dailyBudgetCents ?? params.lifetimeBudgetCents ?? 0;
		await pinterestBatchWrite(credentials, "/ad_groups", "PATCH", {
			id: platformAdSetId,
			budget_in_micro_currency: pinterestMicros(budget),
			budget_type: params.dailyBudgetCents === undefined ? "LIFETIME" : "DAILY",
		});
	},
	async inspectAdMutation(
		accessToken: string,
		platformAdId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<AdProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const ad = await pinterestEntity(credentials, "ads", platformAdId);
		if (!ad) return { exists: false };
		const adGroupId = stringValue(ad.ad_group_id);
		const adGroup = adGroupId
			? await pinterestEntity(credentials, "ad_groups", adGroupId)
			: null;
		const budget = numberValue(adGroup?.budget_in_micro_currency);
		return {
			exists: true,
			name: stringValue(ad.name),
			status: pinterestMutationStatus(ad.status),
			adSetId: adGroupId,
			dailyBudgetCents:
				adGroup?.budget_type === "DAILY" && budget !== undefined
					? Math.round(budget / 10_000)
					: null,
			lifetimeBudgetCents:
				adGroup?.budget_type === "LIFETIME" && budget !== undefined
					? Math.round(budget / 10_000)
					: null,
			targeting: objectValue(adGroup?.targeting_spec) ?? undefined,
		};
	},
	async inspectCampaignMutation(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId?: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<CampaignProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const campaign = await pinterestEntity(
			credentials,
			"campaigns",
			platformCampaignId,
		);
		if (!campaign) return { exists: false };
		const adGroup = platformAdSetId
			? await pinterestEntity(credentials, "ad_groups", platformAdSetId)
			: null;
		const budget = numberValue(adGroup?.budget_in_micro_currency);
		return {
			exists: true,
			name: stringValue(campaign.name),
			status: pinterestMutationStatus(campaign.status),
			adSetStatus: adGroup
				? pinterestMutationStatus(adGroup.status)
				: undefined,
			dailyBudgetCents:
				adGroup?.budget_type === "DAILY" && budget !== undefined
					? Math.round(budget / 10_000)
					: null,
			lifetimeBudgetCents:
				adGroup?.budget_type === "LIFETIME" && budget !== undefined
					? Math.round(budget / 10_000)
					: null,
		};
	},
	async pauseAd(accessToken, platformAdId, providerCredentials): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await pinterestBatchWrite(credentials, "/ads", "PATCH", {
			id: platformAdId,
			status: "PAUSED",
		});
	},
	async resumeAd(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await pinterestBatchWrite(credentials, "/ads", "PATCH", {
			id: platformAdId,
			status: "ACTIVE",
		});
	},
	async cancelAd(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await pinterestBatchWrite(credentials, "/ads", "PATCH", {
			id: platformAdId,
			status: "ARCHIVED",
		});
	},
	async pauseCampaign(
		accessToken,
		platformCampaignId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await pinterestBatchWrite(credentials, "/campaigns", "PATCH", {
			id: platformCampaignId,
			status: "PAUSED",
		});
	},
	async resumeCampaign(
		accessToken,
		platformCampaignId,
		providerCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		await pinterestBatchWrite(credentials, "/campaigns", "PATCH", {
			id: platformCampaignId,
			status: "ACTIVE",
		});
	},
	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const accounts = await pinterestList(credentials, "/ad_accounts");
		return accounts.flatMap((account) => {
			const id = stringValue(account.id);
			if (!id) return [];
			return [
				{
					id,
					name: stringValue(account.name) ?? `Pinterest Ads ${id}`,
					currency: stringValue(account.currency),
					status:
						!stringValue(account.status) ||
						stringValue(account.status)?.toUpperCase() === "ACTIVE"
							? "active"
							: "disabled",
					metadata: { provider_status: stringValue(account.status) },
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
			pinterestList(
				credentials,
				`/ad_accounts/${encodeURIComponent(adAccountId)}/campaigns`,
			),
			pinterestList(
				credentials,
				`/ad_accounts/${encodeURIComponent(adAccountId)}/ad_groups`,
			),
			pinterestList(
				credentials,
				`/ad_accounts/${encodeURIComponent(adAccountId)}/ads`,
			),
		]);
		const campaigns = new Map(
			campaignRows
				.map((row) => [stringValue(row.id), row] as const)
				.filter((entry): entry is [string, Record<string, unknown>] =>
					Boolean(entry[0]),
				),
		);
		const adGroups = new Map(
			adGroupRows
				.map((row) => [stringValue(row.id), row] as const)
				.filter((entry): entry is [string, Record<string, unknown>] =>
					Boolean(entry[0]),
				),
		);
		const ads: ExternalAdData[] = [];
		for (const row of adRows) {
			const adId = stringValue(row.id);
			const campaignId = stringValue(row.campaign_id);
			const adGroupId = stringValue(row.ad_group_id);
			if (!adId || !campaignId) continue;
			const campaign = campaigns.get(campaignId);
			const adGroup = adGroupId ? adGroups.get(adGroupId) : undefined;
			const dailyBudgetMicros =
				numberValue(adGroup?.budget_in_micro_currency) ??
				numberValue(campaign?.daily_spend_cap);
			ads.push({
				platformCampaignId: campaignId,
				campaignName: stringValue(campaign?.name) ?? `Campaign ${campaignId}`,
				platformAdSetId: adGroupId,
				adSetName: stringValue(adGroup?.name),
				platformAdId: adId,
				adName: stringValue(row.name) ?? `Ad ${adId}`,
				status: pinterestStatus(row.status ?? adGroup?.status),
				objective: pinterestObjective(campaign?.objective_type),
				dailyBudgetCents:
					dailyBudgetMicros === undefined
						? undefined
						: Math.round(dailyBudgetMicros / 10_000),
				creative: {
					body: stringValue(row.description),
					linkUrl: stringValue(row.destination_url),
				},
			});
		}
		return { ads, totalFound: ads.length };
	},

	async getAdMetrics(
		accessToken: string,
		platformAdId: string,
		dateRange: DateRange,
		_breakdowns?: string[],
		providerCredentials?: AdProviderCredentials,
	): Promise<AdMetricsWithDemographics> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const adAccountId = providerCredentials?.providerAdAccountId;
		if (!adAccountId) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"Pinterest analytics requires the provider ad account ID",
			);
		}
		const url = new URL(
			`${PINTEREST_BASE}/ad_accounts/${encodeURIComponent(adAccountId)}/ads/analytics`,
		);
		url.searchParams.set("start_date", dateRange.startDate);
		url.searchParams.set("end_date", dateRange.endDate);
		url.searchParams.set("ad_ids", platformAdId);
		url.searchParams.set("granularity", "DAY");
		url.searchParams.set(
			"columns",
			"AD_ID,DATE,IMPRESSION_1,PIN_CLICK,SPEND_IN_MICRO_DOLLAR,TOTAL_CONVERSIONS,VIDEO_MRC_VIEWS,SAVE",
		);
		const { data } = await fetchProviderJson<unknown>({
			platform: "pinterest",
			url: url.toString(),
			init: { headers: pinterestHeaders(credentials) },
		});
		const rows = Array.isArray(data)
			? data
			: arrayValue(objectValue(data)?.items);
		const daily: AdMetricPoint[] = rows.flatMap((item) => {
			const row = objectValue(item);
			const date = stringValue(row?.DATE);
			if (!row || !date) return [];
			const impressions = numberValue(row.IMPRESSION_1) ?? 0;
			const clicks = numberValue(row.PIN_CLICK) ?? 0;
			const spendCents = Math.round(
				(numberValue(row.SPEND_IN_MICRO_DOLLAR) ?? 0) / 10_000,
			);
			return [
				{
					date,
					impressions,
					reach: 0,
					clicks,
					spendCents,
					conversions: numberValue(row.TOTAL_CONVERSIONS) ?? 0,
					videoViews: numberValue(row.VIDEO_MRC_VIEWS) ?? 0,
					engagement: clicks + (numberValue(row.SAVE) ?? 0),
					ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
					cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : 0,
					cpmCents:
						impressions > 0 ? Math.round((spendCents * 1000) / impressions) : 0,
				},
			];
		});
		return { daily };
	},

	async listAudiences(
		accessToken: string,
		adAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAudience[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const rows = await pinterestList(
			credentials,
			`/ad_accounts/${encodeURIComponent(adAccountId)}/audiences`,
		);
		return rows.flatMap((row) => {
			const id = stringValue(row.id);
			const name = stringValue(row.name);
			if (!id || !name) return [];
			const type = stringValue(row.audience_type)?.toUpperCase() ?? "";
			return [
				{
					id,
					name,
					type: type.includes("VISITOR")
						? "website"
						: type.includes("ACTALIKE")
							? "lookalike"
							: "customer_list",
					description: stringValue(row.description) ?? null,
					size: numberValue(row.size) ?? null,
					status: stringValue(row.status)?.toLowerCase() ?? null,
				},
			];
		});
	},
};
