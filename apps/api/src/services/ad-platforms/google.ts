// Google Ads API v25 adapter.
// Official sources:
// - REST authentication and required developer-token/login-customer-id headers:
//   https://developers.google.com/google-ads/api/rest/auth
// - Account discovery (customers:listAccessibleCustomers):
//   https://developers.google.com/google-ads/api/rest/reference/rest/v25/customers/listAccessibleCustomers
// - GAQL reporting/search:
//   https://developers.google.com/google-ads/api/docs/query/overview
// - Responsive Search Ad requirements:
//   https://developers.google.com/google-ads/api/docs/responsive-search-ads/create-responsive-search-ads
// - Atomic mixed-resource writes and temporary resource names (GoogleAdsService.Mutate):
//   https://developers.google.com/google-ads/api/docs/mutating/best-practices
//   POST /v25/customers/{customerId}/googleAds:mutate with mutateOperations
// - Absolute updates use updateMask; removals use the resource-name `remove` field:
//   https://developers.google.com/google-ads/api/docs/mutating/service-mutates
// - Correlation uses an unreferenced Ad.url_custom_parameters entry (key/value,
//   max 16/200 bytes), selected through GAQL and never appended to a final URL:
//   https://developers.google.com/google-ads/api/docs/ads/upgraded-urls/fields

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
	AdProviderCreationAdapter,
	AdProviderCredentials,
	AdProviderMutationPreflight,
	AdProviderMutationState,
	CampaignProviderMutationState,
	CreateCampaignParams,
	CreateCreativeParams,
	CreatePlatformAdParams,
	DateRange,
	ExternalAdData,
	ExternalAdSyncResult,
	FindCreatedAdObjectParams,
	PlatformAdAccount,
	PlatformAudience,
} from "./types";
import { AdPlatformError } from "./types";
import { unsupportedAdAdapter } from "./unsupported";

const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${API_VERSIONS.google_ads}`;
const MAX_SEARCH_PAGES = 20;

const capabilities: AdPlatformCapabilities = {
	apiVersion: API_VERSIONS.google_ads,
	authProtocol: "oauth2",
	requiresDedicatedConnection: true,
	requiredScopes: ["https://www.googleapis.com/auth/adwords"],
	operations: {
		account_discovery: { state: "supported" },
		external_sync: { state: "supported" },
		analytics: { state: "supported" },
		campaign_create: { state: "supported" },
		ad_create: { state: "supported" },
		boost: {
			state: "unsupported",
			reason: "Google Ads has no social-post boost operation",
		},
		mutation: {
			state: "supported",
			reason:
				"Absolute status/cancel/budget and campaign-name mutations are supported; responsive-search-ad names and targeting are immutable or require a separate typed operation",
		},
		targeting_search: {
			state: "requires_approval",
			reason:
				"Audience Insights is access-level dependent and is not treated as a generic interest search",
		},
		audience_discovery: { state: "supported" },
		audience_create: {
			state: "requires_approval",
			reason:
				"Customer Match eligibility and the 2026 Data Manager migration must be verified for the developer token and account",
		},
		audience_upload: {
			state: "requires_approval",
			reason:
				"Customer Match upload is account-policy and developer-token eligible only",
		},
	},
	objectives: ["traffic", "conversions"],
	formats: ["responsive_search_ad"],
	officialDocs: [
		"https://developers.google.com/google-ads/api/rest/auth",
		"https://developers.google.com/google-ads/api/docs/query/overview",
		"https://developers.google.com/google-ads/api/docs/mutating/best-practices",
		"https://developers.google.com/google-ads/api/docs/ads/create-ads",
		"https://developers.google.com/google-ads/api/docs/best-practices/quotas",
	],
};

function credentialsOrThrow(
	accessToken: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	if (!accessToken || !credentials?.developerToken) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"Google Ads requires a dedicated OAuth connection and GOOGLE_ADS_DEVELOPER_TOKEN",
		);
	}
	return { ...credentials, accessToken };
}

function googleHeaders(credentials: AdProviderCredentials): HeadersInit {
	return {
		Authorization: `Bearer ${credentials.accessToken}`,
		"developer-token": credentials.developerToken ?? "",
		...(credentials.loginCustomerId
			? { "login-customer-id": credentials.loginCustomerId.replaceAll("-", "") }
			: {}),
		"Content-Type": "application/json",
	};
}

async function googleSearch(
	credentials: AdProviderCredentials,
	customerId: string,
	query: string,
): Promise<Record<string, unknown>[]> {
	const results: Record<string, unknown>[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
		const { data } = await fetchProviderJson<unknown>({
			platform: "google",
			url: `${GOOGLE_ADS_BASE}/customers/${encodeURIComponent(customerId.replaceAll("-", ""))}/googleAds:search`,
			init: {
				method: "POST",
				headers: googleHeaders(credentials),
				body: JSON.stringify({ query, pageSize: 1000, pageToken }),
			},
		});
		const envelope = objectValue(data);
		if (!envelope) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Google Ads search returned a non-object response",
			);
		}
		for (const item of arrayValue(envelope.results)) {
			const object = objectValue(item);
			if (object) results.push(object);
		}
		pageToken = stringValue(envelope.nextPageToken);
		if (!pageToken) break;
	}
	return results;
}

function googleStatus(value: unknown): string {
	switch (stringValue(value)?.toUpperCase()) {
		case "ENABLED":
			return "active";
		case "PAUSED":
			return "paused";
		case "REMOVED":
			return "cancelled";
		case "PENDING":
			return "pending_review";
		default:
			return "draft";
	}
}

function googleObjective(channelType: unknown): string {
	switch (stringValue(channelType)?.toUpperCase()) {
		case "VIDEO":
			return "video_views";
		case "DISPLAY":
		case "DISCOVERY":
		case "DEMAND_GEN":
			return "awareness";
		case "SHOPPING":
		case "PERFORMANCE_MAX":
			return "conversions";
		default:
			return "traffic";
	}
}

function customerIdFromResourceName(resourceName: string): string | null {
	return resourceName.match(/^customers\/(\d+)\//)?.[1] ?? null;
}

function textAssetValues(value: unknown): string[] {
	return arrayValue(value)
		.map((asset) => stringValue(objectValue(asset)?.text))
		.filter((text): text is string => Boolean(text));
}

type GoogleCampaignSettings = Extract<
	AdCampaignProviderOptions,
	{ platform: "google" }
>["settings"];
type GoogleCreativeSettings = Extract<
	AdCreateProviderOptions,
	{ platform: "google" }
>["creative"];

function googleCampaignSettings(
	params: Pick<CreateCampaignParams, "providerOptions">,
): GoogleCampaignSettings {
	const options = params.providerOptions;
	if (options?.platform !== "google") {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"Google Ads requires provider_options.platform=google",
		);
	}
	const settings = "settings" in options ? options.settings : options.campaign;
	if (!settings) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"Google Ads requires campaign provider options when creating a campaign hierarchy",
		);
	}
	return settings;
}

function googleCreativeSettings(
	params: Pick<CreateCreativeParams, "providerOptions">,
): GoogleCreativeSettings {
	const options = params.providerOptions;
	if (options?.platform !== "google") {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"Google Responsive Search Ads require google creative provider options",
		);
	}
	return options.creative;
}

function validateGoogleCampaign(
	params: Pick<
		CreateCampaignParams,
		| "objective"
		| "dailyBudgetCents"
		| "lifetimeBudgetCents"
		| "startDate"
		| "endDate"
		| "providerOptions"
	>,
): void {
	const settings = googleCampaignSettings(params);
	if (!["traffic", "conversions"].includes(params.objective)) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"Google Search campaigns support the traffic and conversions Relay objectives",
		);
	}
	if (
		Boolean(params.dailyBudgetCents) === Boolean(params.lifetimeBudgetCents)
	) {
		throw new AdPlatformError(
			"INVALID_BUDGET",
			"Google Search campaigns require exactly one daily or lifetime budget",
		);
	}
	if (params.lifetimeBudgetCents && (!params.startDate || !params.endDate)) {
		throw new AdPlatformError(
			"INVALID_BUDGET",
			"Google campaign total budgets require start_date and end_date",
		);
	}
	if (
		settings.bidding_strategy === "MANUAL_CPC" &&
		!settings.default_cpc_bid_cents
	) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"Google MANUAL_CPC campaigns require default_cpc_bid_cents",
		);
	}
}

function normalizeCustomerId(value: string): string {
	const normalized = value.replaceAll("-", "");
	if (!/^\d+$/.test(normalized)) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_RESOURCE",
			"Google Ads customer IDs must contain digits only",
		);
	}
	return normalized;
}

function credentialsForCustomer(
	accessToken: string,
	customerId: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	const resolved = credentialsOrThrow(accessToken, credentials);
	const normalized = normalizeCustomerId(customerId);
	if (
		resolved.providerAdAccountId &&
		normalizeCustomerId(resolved.providerAdAccountId) !== normalized
	) {
		throw new AdPlatformError(
			"PROVIDER_ACCOUNT_MISMATCH",
			"The Google Ads resource does not belong to the authorized customer",
		);
	}
	if (
		resolved.grantedScopes &&
		!resolved.grantedScopes.some(
			(scope) => scope === "https://www.googleapis.com/auth/adwords",
		)
	) {
		throw new AdPlatformError(
			"ADS_SCOPE_MISSING",
			"Google Ads writes require https://www.googleapis.com/auth/adwords",
		);
	}
	return resolved;
}

function customerFromResource(resourceName: string): string {
	const customerId = customerIdFromResourceName(resourceName);
	if (!customerId) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_RESOURCE",
			"Google Ads mutations require a canonical customer resource name",
		);
	}
	return customerId;
}

function micros(cents: number): string {
	return String(cents * 10_000);
}

function dateOnly(value: string | undefined): string | undefined {
	return value ? value.slice(0, 10) : undefined;
}

function googleProviderName(value: string): string {
	return value.length <= 255 ? value : value.slice(value.length - 255);
}

function markerFromProviderName(value: string): string {
	const marker = value.match(/\[relay:[^\]]+\]/)?.[0];
	if (!marker) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"The durable Google Ads correlation marker is missing",
		);
	}
	return marker;
}

function gaqlString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function resourceFromMutation(data: unknown, resultKey: string): string | null {
	for (const item of arrayValue(objectValue(data)?.mutateOperationResponses)) {
		const response = objectValue(item);
		const result = objectValue(response?.[resultKey]);
		const resourceName = stringValue(result?.resourceName);
		if (resourceName) return resourceName;
	}
	return null;
}

async function googleMutate(
	credentials: AdProviderCredentials,
	customerId: string,
	mutateOperations: Record<string, unknown>[],
): Promise<unknown> {
	const { data } = await fetchProviderJson<unknown>({
		platform: "google",
		url: `${GOOGLE_ADS_BASE}/customers/${encodeURIComponent(customerId)}/googleAds:mutate`,
		init: {
			method: "POST",
			headers: googleHeaders(credentials),
			body: JSON.stringify({
				mutateOperations,
				partialFailure: false,
				responseContentType: "RESOURCE_NAME_ONLY",
			}),
		},
	});
	return data;
}

function biddingStrategy(settings: GoogleCampaignSettings) {
	switch (settings.bidding_strategy) {
		case "MAXIMIZE_CLICKS":
			return { maximizeClicks: {} };
		case "MAXIMIZE_CONVERSIONS":
			return { maximizeConversions: {} };
		default:
			return { manualCpc: { enhancedCpcEnabled: false } };
	}
}

function canonicalGoogleStatus(value: unknown): string | undefined {
	switch (stringValue(value)?.toUpperCase()) {
		case "ENABLED":
			return "ACTIVE";
		case "PAUSED":
			return "PAUSED";
		case "REMOVED":
			return "DELETED";
		default:
			return stringValue(value)?.toUpperCase();
	}
}

function creativeResourceFromAdGroupAd(resourceName: string): string {
	const match = resourceName.match(/^customers\/(\d+)\/adGroupAds\/\d+~(\d+)$/);
	if (!match?.[1] || !match[2]) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"Google Ads returned an invalid ad-group-ad resource name",
		);
	}
	return `customers/${match[1]}/ads/${match[2]}`;
}

async function googleAdMutationRow(
	credentials: AdProviderCredentials,
	platformAdId: string,
): Promise<Record<string, unknown> | undefined> {
	const customerId = customerFromResource(platformAdId);
	const [row] = await googleSearch(
		credentials,
		customerId,
		`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group.resource_name, ad_group.status, campaign.resource_name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM ad_group_ad WHERE ad_group_ad.resource_name = '${gaqlString(platformAdId)}' LIMIT 1`,
	);
	return row;
}

async function googleCampaignMutationRow(
	credentials: AdProviderCredentials,
	platformCampaignId: string,
	platformAdSetId?: string,
): Promise<Record<string, unknown> | undefined> {
	const customerId = customerFromResource(platformCampaignId);
	const query = platformAdSetId
		? `SELECT campaign.resource_name, campaign.name, campaign.status, ad_group.resource_name, ad_group.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM ad_group WHERE ad_group.resource_name = '${gaqlString(platformAdSetId)}' AND campaign.resource_name = '${gaqlString(platformCampaignId)}' LIMIT 1`
		: `SELECT campaign.resource_name, campaign.name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.total_amount_micros FROM campaign WHERE campaign.resource_name = '${gaqlString(platformCampaignId)}' LIMIT 1`;
	const [row] = await googleSearch(credentials, customerId, query);
	return row;
}

function budgetState(row: Record<string, unknown> | undefined) {
	const budget = objectValue(row?.campaignBudget);
	return {
		resourceName: stringValue(budget?.resourceName),
		dailyBudgetCents:
			budget?.amountMicros === undefined
				? null
				: Math.round((numberValue(budget.amountMicros) ?? 0) / 10_000),
		lifetimeBudgetCents:
			budget?.totalAmountMicros === undefined
				? null
				: Math.round((numberValue(budget.totalAmountMicros) ?? 0) / 10_000),
	};
}

const base = unsupportedAdAdapter("google", capabilities);

const googleCreation: AdProviderCreationAdapter = {
	coalescesCreativeAndAd: true,

	async createCampaign(accessToken, adAccountId, params, providerCredentials) {
		validateGoogleCampaign(params);
		const customerId = normalizeCustomerId(adAccountId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const settings = googleCampaignSettings(params);
		const marker = markerFromProviderName(params.name);
		const budgetResource = `customers/${customerId}/campaignBudgets/-1`;
		const campaignResource = `customers/${customerId}/campaigns/-2`;
		const budget = params.lifetimeBudgetCents
			? {
					resourceName: budgetResource,
					name: `Relay budget ${marker}`,
					explicitlyShared: false,
					period: "CUSTOM_PERIOD",
					totalAmountMicros: micros(params.lifetimeBudgetCents),
				}
			: {
					resourceName: budgetResource,
					name: `Relay budget ${marker}`,
					explicitlyShared: false,
					deliveryMethod: "STANDARD",
					amountMicros: micros(params.dailyBudgetCents ?? 0),
				};
		const network = settings.network_settings;
		const campaign: Record<string, unknown> = {
			resourceName: campaignResource,
			name: googleProviderName(params.name),
			campaignBudget: budgetResource,
			advertisingChannelType: "SEARCH",
			containsEuPoliticalAdvertising:
				settings.contains_eu_political_advertising,
			status: "PAUSED",
			networkSettings: {
				targetGoogleSearch: network?.target_google_search ?? true,
				targetSearchNetwork: network?.target_search_network ?? true,
				targetContentNetwork: network?.target_content_network ?? false,
				targetPartnerSearchNetwork:
					network?.target_partner_search_network ?? false,
			},
			...biddingStrategy(settings),
			...(dateOnly(params.startDate)
				? { startDate: dateOnly(params.startDate) }
				: {}),
			...(dateOnly(params.endDate)
				? { endDate: dateOnly(params.endDate) }
				: {}),
		};
		const operations: Record<string, unknown>[] = [
			{ campaignBudgetOperation: { create: budget } },
			{ campaignOperation: { create: campaign } },
		];
		for (const id of settings.geo_target_constant_ids ?? []) {
			operations.push({
				campaignCriterionOperation: {
					create: {
						campaign: campaignResource,
						location: { geoTargetConstant: `geoTargetConstants/${id}` },
					},
				},
			});
		}
		for (const id of settings.language_constant_ids ?? []) {
			operations.push({
				campaignCriterionOperation: {
					create: {
						campaign: campaignResource,
						language: { languageConstant: `languageConstants/${id}` },
					},
				},
			});
		}
		const data = await googleMutate(credentials, customerId, operations);
		const resourceName = resourceFromMutation(data, "campaignResult");
		if (!resourceName) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Google Ads did not return the created campaign resource",
			);
		}
		return resourceName;
	},

	async createAdSet(accessToken, adAccountId, params, providerCredentials) {
		const customerId = normalizeCustomerId(adAccountId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		if (customerFromResource(params.campaignId) !== customerId) {
			throw new AdPlatformError(
				"PROVIDER_ACCOUNT_MISMATCH",
				"The Google campaign does not belong to the authorized customer",
			);
		}
		const settings = googleCampaignSettings(params);
		const adGroupResource = `customers/${customerId}/adGroups/-10`;
		const adGroup: Record<string, unknown> = {
			resourceName: adGroupResource,
			campaign: params.campaignId,
			name: googleProviderName(params.name),
			status: "PAUSED",
			type: "SEARCH_STANDARD",
			...(settings.default_cpc_bid_cents
				? { cpcBidMicros: micros(settings.default_cpc_bid_cents) }
				: {}),
		};
		const operations: Record<string, unknown>[] = [
			{ adGroupOperation: { create: adGroup } },
			...settings.keywords.map((keyword) => ({
				adGroupCriterionOperation: {
					create: {
						adGroup: adGroupResource,
						status: "ENABLED",
						keyword: {
							text: keyword.text,
							matchType: keyword.match_type,
						},
					},
				},
			})),
		];
		const data = await googleMutate(credentials, customerId, operations);
		const resourceName = resourceFromMutation(data, "adGroupResult");
		if (!resourceName) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Google Ads did not return the created ad group resource",
			);
		}
		return resourceName;
	},

	async createCreative() {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Google creates the responsive-search creative and ad atomically",
		);
	},

	async createAd() {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Google creates the responsive-search creative and ad atomically",
		);
	},

	async createCreativeAndAd(
		accessToken: string,
		adAccountId: string,
		creative: CreateCreativeParams,
		ad: CreatePlatformAdParams,
		providerCredentials?: AdProviderCredentials,
	) {
		const customerId = normalizeCustomerId(adAccountId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		if (customerFromResource(ad.adSetId) !== customerId) {
			throw new AdPlatformError(
				"PROVIDER_ACCOUNT_MISMATCH",
				"The Google ad group does not belong to the authorized customer",
			);
		}
		const settings = googleCreativeSettings(creative);
		const marker = markerFromProviderName(creative.name);
		const data = await googleMutate(credentials, customerId, [
			{
				adGroupAdOperation: {
					create: {
						adGroup: ad.adSetId,
						status: ad.active ? "ENABLED" : "PAUSED",
						ad: {
							finalUrls: settings.final_urls,
							urlCustomParameters: [{ key: "relayop", value: marker }],
							responsiveSearchAd: {
								headlines: settings.headlines.map((text) => ({ text })),
								descriptions: settings.descriptions.map((text) => ({
									text,
								})),
								...(settings.path1 ? { path1: settings.path1 } : {}),
								...(settings.path2 ? { path2: settings.path2 } : {}),
							},
						},
					},
				},
			},
		]);
		const adId = resourceFromMutation(data, "adGroupAdResult");
		if (!adId) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"Google Ads did not return the created responsive-search ad",
			);
		}
		return { creativeId: creativeResourceFromAdGroupAd(adId), adId };
	},

	async findCreatedCreativeAndAd(
		accessToken,
		adAccountId,
		params,
		providerCredentials,
	) {
		const customerId = normalizeCustomerId(adAccountId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		if (!params.platformAdSetId) return null;
		const rows = await googleSearch(
			credentials,
			customerId,
			`SELECT ad_group_ad.resource_name, ad_group_ad.ad.id, ad_group_ad.ad.url_custom_parameters FROM ad_group_ad WHERE ad_group.resource_name = '${gaqlString(params.platformAdSetId)}' LIMIT 1000`,
		);
		for (const row of rows) {
			const adGroupAd = objectValue(row.adGroupAd);
			const adObject = objectValue(adGroupAd?.ad);
			const matches = arrayValue(adObject?.urlCustomParameters).some((item) => {
				const parameter = objectValue(item);
				return (
					stringValue(parameter?.key) === "relayop" &&
					stringValue(parameter?.value) === params.marker
				);
			});
			const adId = stringValue(adGroupAd?.resourceName);
			if (matches && adId) {
				return { creativeId: creativeResourceFromAdGroupAd(adId), adId };
			}
		}
		return null;
	},

	async findCreatedObject(
		accessToken: string,
		adAccountId: string,
		params: FindCreatedAdObjectParams,
		providerCredentials?: AdProviderCredentials,
	) {
		const customerId = normalizeCustomerId(adAccountId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const marker = gaqlString(params.marker);
		const query =
			params.phase === "campaign"
				? `SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.name LIKE '%${marker}%' LIMIT 100`
				: params.phase === "ad_set"
					? `SELECT ad_group.resource_name, ad_group.name FROM ad_group WHERE ad_group.name LIKE '%${marker}%' LIMIT 100`
					: null;
		if (!query) {
			const pair = await this.findCreatedCreativeAndAd?.(
				accessToken,
				adAccountId,
				params,
				providerCredentials,
			);
			return pair?.adId ?? null;
		}
		const [row] = await googleSearch(credentials, customerId, query);
		return params.phase === "campaign"
			? (stringValue(objectValue(row?.campaign)?.resourceName) ?? null)
			: (stringValue(objectValue(row?.adGroup)?.resourceName) ?? null);
	},

	async activateBoost(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		_refresh,
		providerCredentials,
	) {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		if (customerFromResource(platformAdSetId) !== customerId) {
			throw new AdPlatformError(
				"PROVIDER_ACCOUNT_MISMATCH",
				"The Google ad group does not belong to its campaign customer",
			);
		}
		await googleMutate(credentials, customerId, [
			{
				campaignOperation: {
					update: { resourceName: platformCampaignId, status: "ENABLED" },
					updateMask: "status",
				},
			},
			{
				adGroupOperation: {
					update: { resourceName: platformAdSetId, status: "ENABLED" },
					updateMask: "status",
				},
			},
		]);
	},

	async isBoostActivated(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		providerCredentials,
	) {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const [row] = await googleSearch(
			credentials,
			customerId,
			`SELECT campaign.status, ad_group.status FROM ad_group WHERE ad_group.resource_name = '${gaqlString(platformAdSetId)}' AND campaign.resource_name = '${gaqlString(platformCampaignId)}' LIMIT 1`,
		);
		return (
			stringValue(objectValue(row?.campaign)?.status) === "ENABLED" &&
			stringValue(objectValue(row?.adGroup)?.status) === "ENABLED"
		);
	},
};

export const googleAdAdapter: AdPlatformAdapter = {
	...base,
	creation: googleCreation,
	validateCreateCampaign(params) {
		validateGoogleCampaign(params);
	},
	validateCreateAd(params) {
		googleCreativeSettings(params);
		if (!params.campaignId) {
			if (!params.objective) {
				throw new AdPlatformError(
					"MISSING_OBJECTIVE",
					"Google campaign creation requires an objective",
				);
			}
			validateGoogleCampaign({
				...params,
				objective: params.objective,
			});
		}
	},
	validateMutation(payload: AdProviderMutationPreflight) {
		if (payload.kind === "update_ad" && payload.changes?.name !== undefined) {
			throw new AdPlatformError(
				"UNSUPPORTED_MUTATION",
				"Google Responsive Search Ad names are immutable and unsupported",
			);
		}
		if (payload.kind === "update_ad" && payload.changes?.targeting) {
			throw new AdPlatformError(
				"UNSUPPORTED_MUTATION",
				"Google keyword/location targeting changes require a separate typed operation",
			);
		}
		if (
			payload.changes?.dailyBudgetCents !== undefined &&
			payload.changes.lifetimeBudgetCents !== undefined
		) {
			throw new AdPlatformError(
				"INVALID_BUDGET",
				"Google budgets cannot be daily and lifetime in the same mutation",
			);
		}
	},
	async updateAd(
		accessToken,
		platformAdId,
		params,
		_refreshAccessTokenBeforeAdSet,
		providerCredentials,
	) {
		const customerId = customerFromResource(platformAdId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const operations: Record<string, unknown>[] = [];
		if (params.status !== undefined) {
			operations.push({
				adGroupAdOperation: {
					update: {
						resourceName: platformAdId,
						status: params.status === "active" ? "ENABLED" : "PAUSED",
					},
					updateMask: "status",
				},
			});
		}
		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			const row = await googleAdMutationRow(credentials, platformAdId);
			const budget = budgetState(row);
			if (!budget.resourceName) {
				throw new AdPlatformError(
					"INVALID_STATE",
					"The Google ad campaign has no mutable campaign budget",
				);
			}
			if (params.dailyBudgetCents !== undefined) {
				if (budget.lifetimeBudgetCents !== null) {
					throw new AdPlatformError(
						"UNSUPPORTED_MUTATION",
						"Google campaign budget periods cannot be changed from lifetime to daily",
					);
				}
				operations.push({
					campaignBudgetOperation: {
						update: {
							resourceName: budget.resourceName,
							amountMicros: micros(params.dailyBudgetCents),
						},
						updateMask: "amountMicros",
					},
				});
			}
			if (params.lifetimeBudgetCents !== undefined) {
				if (budget.lifetimeBudgetCents === null) {
					throw new AdPlatformError(
						"UNSUPPORTED_MUTATION",
						"Google campaign budget periods cannot be changed from daily to lifetime",
					);
				}
				operations.push({
					campaignBudgetOperation: {
						update: {
							resourceName: budget.resourceName,
							totalAmountMicros: micros(params.lifetimeBudgetCents),
						},
						updateMask: "totalAmountMicros",
					},
				});
			}
		}
		if (operations.length > 0) {
			await googleMutate(credentials, customerId, operations);
		}
	},
	async updateCampaign(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		params,
		providerCredentials,
	) {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		if (
			platformAdSetId &&
			customerFromResource(platformAdSetId) !== customerId
		) {
			throw new AdPlatformError(
				"PROVIDER_ACCOUNT_MISMATCH",
				"The Google ad group does not belong to the campaign customer",
			);
		}
		const operations: Record<string, unknown>[] = [];
		if (params.name !== undefined) {
			operations.push({
				campaignOperation: {
					update: {
						resourceName: platformCampaignId,
						name: googleProviderName(params.name),
					},
					updateMask: "name",
				},
			});
		}
		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			const row = await googleCampaignMutationRow(
				credentials,
				platformCampaignId,
				platformAdSetId,
			);
			const budget = budgetState(row);
			if (!budget.resourceName) {
				throw new AdPlatformError(
					"INVALID_STATE",
					"The Google campaign has no mutable campaign budget",
				);
			}
			if (params.dailyBudgetCents !== undefined) {
				if (budget.lifetimeBudgetCents !== null) {
					throw new AdPlatformError(
						"UNSUPPORTED_MUTATION",
						"Google campaign budget periods cannot be changed from lifetime to daily",
					);
				}
				operations.push({
					campaignBudgetOperation: {
						update: {
							resourceName: budget.resourceName,
							amountMicros: micros(params.dailyBudgetCents),
						},
						updateMask: "amountMicros",
					},
				});
			}
			if (params.lifetimeBudgetCents !== undefined) {
				if (budget.lifetimeBudgetCents === null) {
					throw new AdPlatformError(
						"UNSUPPORTED_MUTATION",
						"Google campaign budget periods cannot be changed from daily to lifetime",
					);
				}
				operations.push({
					campaignBudgetOperation: {
						update: {
							resourceName: budget.resourceName,
							totalAmountMicros: micros(params.lifetimeBudgetCents),
						},
						updateMask: "totalAmountMicros",
					},
				});
			}
		}
		if (operations.length > 0) {
			await googleMutate(credentials, customerId, operations);
		}
	},
	async inspectAdMutation(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<AdProviderMutationState> {
		const customerId = customerFromResource(platformAdId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const row = await googleAdMutationRow(credentials, platformAdId);
		if (!row) return { exists: false };
		const adGroupAd = objectValue(row.adGroupAd);
		const ad = objectValue(adGroupAd?.ad);
		const adGroup = objectValue(row.adGroup);
		const budget = budgetState(row);
		return {
			exists: true,
			name: stringValue(ad?.name),
			status: canonicalGoogleStatus(adGroupAd?.status),
			adSetId: stringValue(adGroup?.resourceName),
			dailyBudgetCents: budget.dailyBudgetCents,
			lifetimeBudgetCents: budget.lifetimeBudgetCents,
		};
	},
	async inspectCampaignMutation(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		providerCredentials,
	): Promise<CampaignProviderMutationState> {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		const row = await googleCampaignMutationRow(
			credentials,
			platformCampaignId,
			platformAdSetId,
		);
		if (!row) return { exists: false };
		const campaign = objectValue(row.campaign);
		const adGroup = objectValue(row.adGroup);
		const budget = budgetState(row);
		return {
			exists: true,
			name: stringValue(campaign?.name),
			status: canonicalGoogleStatus(campaign?.status),
			adSetStatus: canonicalGoogleStatus(adGroup?.status),
			dailyBudgetCents: budget.dailyBudgetCents,
			lifetimeBudgetCents: budget.lifetimeBudgetCents,
		};
	},
	async pauseAd(accessToken, platformAdId, providerCredentials) {
		await this.updateAd(
			accessToken,
			platformAdId,
			{ status: "paused" },
			undefined,
			providerCredentials,
		);
	},
	async resumeAd(accessToken, platformAdId, providerCredentials) {
		await this.updateAd(
			accessToken,
			platformAdId,
			{ status: "active" },
			undefined,
			providerCredentials,
		);
	},
	async cancelAd(accessToken, platformAdId, providerCredentials) {
		const customerId = customerFromResource(platformAdId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		await googleMutate(credentials, customerId, [
			{ adGroupAdOperation: { remove: platformAdId } },
		]);
	},
	async pauseCampaign(accessToken, platformCampaignId, providerCredentials) {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		await googleMutate(credentials, customerId, [
			{
				campaignOperation: {
					update: { resourceName: platformCampaignId, status: "PAUSED" },
					updateMask: "status",
				},
			},
		]);
	},
	async resumeCampaign(accessToken, platformCampaignId, providerCredentials) {
		const customerId = customerFromResource(platformCampaignId);
		const credentials = credentialsForCustomer(
			accessToken,
			customerId,
			providerCredentials,
		);
		await googleMutate(credentials, customerId, [
			{
				campaignOperation: {
					update: { resourceName: platformCampaignId, status: "ENABLED" },
					updateMask: "status",
				},
			},
		]);
	},
	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const { data } = await fetchProviderJson<unknown>({
			platform: "google",
			url: `${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`,
			init: { headers: googleHeaders(credentials) },
		});
		const resourceNames = arrayValue(objectValue(data)?.resourceNames)
			.map(stringValue)
			.filter((value): value is string => Boolean(value))
			.slice(0, 100);

		const accounts: PlatformAdAccount[] = [];
		const concurrency = 5;
		for (let index = 0; index < resourceNames.length; index += concurrency) {
			const batch = resourceNames.slice(index, index + concurrency);
			const details = await Promise.all(
				batch.map(async (resourceName) => {
					const id = resourceName.match(/^customers\/(\d+)$/)?.[1];
					if (!id) return null;
					try {
						const [row] = await googleSearch(
							credentials,
							id,
							"SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.status, customer.manager FROM customer LIMIT 1",
						);
						const customer = objectValue(row?.customer);
						return {
							id,
							name:
								stringValue(customer?.descriptiveName) ?? `Google Ads ${id}`,
							currency: stringValue(customer?.currencyCode),
							timezone: stringValue(customer?.timeZone),
							status:
								stringValue(customer?.status)?.toUpperCase() === "ENABLED"
									? "active"
									: "disabled",
							metadata: {
								manager: customer?.manager === true,
								provider_status: stringValue(customer?.status),
							},
						} satisfies PlatformAdAccount;
					} catch {
						return {
							id,
							name: `Google Ads ${id}`,
							// listAccessibleCustomers already proved read authority. If the
							// optional detail query fails, keep read sync eligible and let its
							// own provider boundary classify a permanent failure.
							status: "active",
						} satisfies PlatformAdAccount;
					}
				}),
			);
			for (const account of details) if (account) accounts.push(account);
		}
		return accounts;
	},

	async syncExternalAds(
		accessToken: string,
		adAccountId: string,
		_since?: Date,
		providerCredentials?: AdProviderCredentials,
	): Promise<ExternalAdSyncResult> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const rows = await googleSearch(
			credentials,
			adAccountId,
			`SELECT campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, ad_group.resource_name, ad_group.name, ad_group.status, ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' LIMIT 10000`,
		);
		const ads: ExternalAdData[] = [];
		for (const row of rows) {
			const campaign = objectValue(row.campaign);
			const campaignBudget = objectValue(row.campaignBudget);
			const adGroup = objectValue(row.adGroup);
			const adGroupAd = objectValue(row.adGroupAd);
			const ad = objectValue(adGroupAd?.ad);
			const responsive = objectValue(ad?.responsiveSearchAd);
			const campaignResource = stringValue(campaign?.resourceName);
			const adResource = stringValue(adGroupAd?.resourceName);
			if (!campaignResource || !adResource) continue;
			const headlines = textAssetValues(responsive?.headlines);
			const descriptions = textAssetValues(responsive?.descriptions);
			ads.push({
				platformCampaignId: campaignResource,
				campaignName:
					stringValue(campaign?.name) ?? `Campaign ${campaignResource}`,
				platformAdSetId: stringValue(adGroup?.resourceName),
				adSetName: stringValue(adGroup?.name),
				platformAdId: adResource,
				adName:
					stringValue(ad?.name) ??
					(headlines[0]
						? headlines[0]
						: `Ad ${stringValue(ad?.id) ?? adResource}`),
				status: googleStatus(adGroupAd?.status ?? adGroup?.status),
				objective: googleObjective(campaign?.advertisingChannelType),
				dailyBudgetCents:
					campaignBudget?.amountMicros === undefined
						? undefined
						: Math.round(
								(numberValue(campaignBudget.amountMicros) ?? 0) / 10_000,
							),
				creative: {
					headline: headlines.join(" | ") || undefined,
					body: descriptions.join(" | ") || undefined,
					linkUrl: arrayValue(ad?.finalUrls).map(stringValue).find(Boolean),
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
		const customerId =
			providerCredentials?.providerAdAccountId ??
			customerIdFromResourceName(platformAdId);
		if (!customerId) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"Google Ads metrics require the provider customer ID",
			);
		}
		const escapedResource = platformAdId.replaceAll("'", "\\'");
		const rows = await googleSearch(
			credentials,
			customerId,
			`SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.video_views, metrics.engagements FROM ad_group_ad WHERE ad_group_ad.resource_name = '${escapedResource}' AND segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}' ORDER BY segments.date`,
		);
		const daily: AdMetricPoint[] = rows.flatMap((row) => {
			const segments = objectValue(row.segments);
			const metrics = objectValue(row.metrics);
			const date = stringValue(segments?.date);
			if (!date) return [];
			const impressions = numberValue(metrics?.impressions) ?? 0;
			const clicks = numberValue(metrics?.clicks) ?? 0;
			const spendCents = Math.round(
				(numberValue(metrics?.costMicros) ?? 0) / 10_000,
			);
			return [
				{
					date,
					impressions,
					reach: 0,
					clicks,
					spendCents,
					conversions: numberValue(metrics?.conversions) ?? 0,
					videoViews: numberValue(metrics?.videoViews) ?? 0,
					engagement: numberValue(metrics?.engagements) ?? clicks,
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
		const rows = await googleSearch(
			credentials,
			adAccountId,
			"SELECT user_list.id, user_list.name, user_list.description, user_list.type, user_list.membership_status, user_list.size_for_display, user_list.size_for_search FROM user_list LIMIT 10000",
		);
		return rows.flatMap((row) => {
			const audience = objectValue(row.userList);
			const id = stringValue(audience?.id);
			const name = stringValue(audience?.name);
			if (!id || !name) return [];
			const type = stringValue(audience?.type)?.toUpperCase();
			return [
				{
					id,
					name,
					type:
						type === "RULE_BASED"
							? "website"
							: type === "SIMILAR"
								? "lookalike"
								: "customer_list",
					description: stringValue(audience?.description) ?? null,
					size:
						numberValue(audience?.sizeForSearch) ??
						numberValue(audience?.sizeForDisplay) ??
						null,
					status:
						stringValue(audience?.membershipStatus)?.toLowerCase() ?? null,
				},
			];
		});
	},
};
