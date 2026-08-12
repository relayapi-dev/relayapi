// LinkedIn Marketing API monthly-version adapter.
// Official sources:
// - Version and Rest.li headers: https://learn.microsoft.com/en-us/linkedin/marketing/versioning
// - Authenticated-user account discovery:
//   https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-account-users
// - Account-scoped campaign and creative search:
//   POST /rest/adAccounts/{id}/adCampaignGroups and
//   POST /rest/adAccounts/{id}/adCampaigns
//   https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns
//   POST /rest/adAccounts/{id}/creatives (201; ID in x-restli-id)
//   https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives
// - Absolute updates use POST plus X-RestLi-Method: PARTIAL_UPDATE and
//   {"patch":{"$set":{...}}}; creative deletion uses PENDING_DELETION
//   (or DELETE while still DRAFT), as documented on the same resource pages.
// - Advertising API access products/scopes:
//   https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access

import { API_VERSIONS } from "../../config/api-versions";
import type {
	AdCampaignProviderOptions,
	AdCreateProviderOptions,
} from "../../schemas/ad-provider-options";
import {
	arrayValue,
	fetchProviderJson,
	fetchProviderOptionalJson,
	objectValue,
	stringValue,
} from "./http";
import type {
	AdPlatformAdapter,
	AdPlatformCapabilities,
	AdProviderCreationAdapter,
	AdProviderCredentials,
	AdProviderMutationPreflight,
	AdProviderMutationState,
	CampaignProviderMutationState,
	CreateCreativeParams,
	CreatePlatformAdParams,
	ExternalAdData,
	ExternalAdSyncResult,
	FindCreatedAdObjectParams,
	PlatformAdAccount,
} from "./types";
import { AdPlatformError } from "./types";
import { unsupportedAdAdapter } from "./unsupported";

const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const MAX_ACCOUNT_PAGES = 20;
const MAX_SEARCH_PAGES = 60;
const CAMPAIGN_STATUSES =
	"ACTIVE,PAUSED,ARCHIVED,COMPLETED,CANCELED,DRAFT,PENDING_DELETION,REMOVED";
const CAMPAIGN_GROUP_STATUSES =
	"ACTIVE,PAUSED,ARCHIVED,CANCELED,DRAFT,PENDING_DELETION,REMOVED";

const capabilities: AdPlatformCapabilities = {
	apiVersion: API_VERSIONS.linkedin_marketing,
	authProtocol: "oauth2",
	requiresDedicatedConnection: true,
	requiredScopes: ["rw_ads"],
	operations: {
		account_discovery: { state: "supported" },
		external_sync: { state: "supported" },
		analytics: {
			state: "requires_approval",
			reason:
				"LinkedIn reporting requires Advertising API approval and r_ads_reporting",
		},
		campaign_create: {
			state: "supported",
			reason:
				"Requires LinkedIn Advertising API access, rw_ads, an eligible ad-account role, and provider-specific campaign settings",
		},
		ad_create: {
			state: "supported",
			reason:
				"Creates a sponsored creative from an existing share, UGC post, or adInMailContent reference; provider review and organization roles still apply",
		},
		boost: {
			state: "requires_approval",
			reason:
				"LinkedIn post promotion requires Advertising API access plus the correct organization/member role",
		},
		mutation: {
			state: "supported",
			reason:
				"Absolute name, delivery-status, campaign-budget, and creative-delete operations are implemented; generic targeting mutation remains unsupported",
		},
		targeting_search: {
			state: "requires_approval",
			reason:
				"LinkedIn targeting facets/entities require Advertising API access and provider facet selection",
		},
		audience_discovery: {
			state: "requires_approval",
			reason: "LinkedIn Matched Audiences is a separately restricted product",
		},
		audience_create: {
			state: "requires_approval",
			reason: "LinkedIn Matched Audiences requires rw_dmp_segments approval",
		},
		audience_upload: {
			state: "requires_approval",
			reason: "LinkedIn Matched Audiences requires rw_dmp_segments approval",
		},
	},
	objectives: [
		"awareness",
		"traffic",
		"engagement",
		"leads",
		"conversions",
		"video_views",
	],
	formats: [
		"existing_post",
		"single_image",
		"single_video",
		"carousel",
		"document",
	],
	officialDocs: [
		"https://learn.microsoft.com/en-us/linkedin/marketing/versioning",
		"https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access",
		"https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups",
		"https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns",
		"https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives",
	],
};

function credentialsOrThrow(
	accessToken: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	if (!accessToken) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"LinkedIn Ads requires a dedicated approved Advertising API connection",
		);
	}
	return {
		...(credentials ?? { metadata: {} }),
		accessToken,
		metadata: credentials?.metadata ?? {},
	};
}

function normalizeLinkedinAccountId(value: string): string {
	const accountId = sponsoredAccountId(value);
	if (!accountId) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_RESOURCE",
			"LinkedIn advertising account IDs must be numeric or a sponsoredAccount URN",
		);
	}
	return accountId;
}

function linkedinWriteCredentials(
	accessToken: string,
	accountId: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	const resolved = credentialsOrThrow(accessToken, credentials);
	const normalizedAccount = normalizeLinkedinAccountId(accountId);
	if (
		resolved.providerAdAccountId &&
		normalizeLinkedinAccountId(resolved.providerAdAccountId) !==
			normalizedAccount
	) {
		throw new AdPlatformError(
			"PROVIDER_ACCOUNT_MISMATCH",
			"The LinkedIn resource does not belong to the authorized ad account",
		);
	}
	if (resolved.grantedScopes && !resolved.grantedScopes.includes("rw_ads")) {
		throw new AdPlatformError(
			"ADS_SCOPE_MISSING",
			"LinkedIn advertising writes require rw_ads",
		);
	}
	return resolved;
}

function linkedinAuthorizedAccount(
	credentials: AdProviderCredentials | undefined,
): string {
	if (!credentials?.providerAdAccountId) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"LinkedIn mutations require a dedicated connection bound to an ad account",
		);
	}
	return normalizeLinkedinAccountId(credentials.providerAdAccountId);
}

function linkedinHeaders(credentials: AdProviderCredentials): HeadersInit {
	return {
		Authorization: `Bearer ${credentials.accessToken}`,
		"Linkedin-Version": API_VERSIONS.linkedin_marketing,
		"X-Restli-Protocol-Version": "2.0.0",
	};
}

function sponsoredAccountId(value: unknown): string | null {
	const raw =
		stringValue(value) ?? stringValue(objectValue(value)?.account) ?? undefined;
	if (!raw) return null;
	return (
		raw.match(/^urn:li:sponsoredAccount:(\d+)$/)?.[1] ??
		(/^\d+$/.test(raw) ? raw : null)
	);
}

function linkedinId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value))
		return String(value);
	return stringValue(value);
}

function linkedinUrnId(value: unknown, entity: string): string | null {
	const raw = linkedinId(value);
	if (!raw) return null;
	if (/^\d+$/.test(raw)) return raw;
	return raw.match(new RegExp(`^urn:li:${entity}:(\\d+)$`))?.[1] ?? null;
}

function sponsoredUrn(
	entity: "sponsoredCampaign" | "sponsoredCampaignGroup" | "sponsoredCreative",
	id: string,
) {
	return `urn:li:${entity}:${id}`;
}

function linkedinStatus(value: unknown): ExternalAdData["status"] {
	switch (stringValue(value)?.toUpperCase()) {
		case "ACTIVE":
			return "active";
		case "PAUSED":
			return "paused";
		case "COMPLETED":
			return "completed";
		case "CANCELED":
		case "ARCHIVED":
		case "PENDING_DELETION":
		case "REMOVED":
			return "cancelled";
		case "DRAFT":
			return "draft";
		default:
			return "pending_review";
	}
}

function linkedinObjective(value: unknown): string {
	switch (stringValue(value)?.toUpperCase()) {
		case "BRAND_AWARENESS":
			return "awareness";
		case "ENGAGEMENT":
			return "engagement";
		case "LEAD_GENERATION":
		case "JOB_APPLICANTS":
			return "leads";
		case "WEBSITE_CONVERSION":
		case "WEBSITE_CONVERSIONS":
			return "conversions";
		case "VIDEO_VIEW":
		case "VIDEO_VIEWS":
			return "video_views";
		default:
			return "traffic";
	}
}

function linkedinMoneyCents(value: unknown): number | undefined {
	const amount = Number(objectValue(value)?.amount);
	return Number.isFinite(amount) && amount >= 0
		? Math.round(amount * 100)
		: undefined;
}

function linkedinDate(value: unknown): string | undefined {
	const milliseconds = Number(value);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function linkedinSearch(
	credentials: AdProviderCredentials,
	path: string,
	query: Record<string, string>,
	additionalHeaders?: HeadersInit,
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
		const url = new URL(`${LINKEDIN_REST_BASE}${path}`);
		for (const [key, value] of Object.entries(query)) {
			url.searchParams.set(key, value);
		}
		url.searchParams.set("pageSize", "100");
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const { data } = await fetchProviderJson<unknown>({
			platform: "linkedin",
			url: url.toString(),
			init: {
				headers: { ...linkedinHeaders(credentials), ...additionalHeaders },
			},
		});
		const envelope = objectValue(data);
		if (!envelope) {
			throw new AdPlatformError(
				"PROVIDER_PROTOCOL_ERROR",
				"LinkedIn search returned a non-object response",
			);
		}
		for (const item of arrayValue(envelope.elements)) {
			const row = objectValue(item);
			if (row) rows.push(row);
		}
		pageToken = stringValue(objectValue(envelope.metadata)?.nextPageToken);
		if (!pageToken) break;
	}
	return rows;
}

type LinkedinCampaignSettings = Extract<
	AdCampaignProviderOptions,
	{ platform: "linkedin" }
>["settings"];
type LinkedinCreativeSettings = Extract<
	AdCreateProviderOptions,
	{ platform: "linkedin" }
>["creative"];

function linkedinCampaignSettings(params: {
	providerOptions?: AdCampaignProviderOptions | AdCreateProviderOptions;
}): LinkedinCampaignSettings {
	const options = params.providerOptions;
	if (options?.platform !== "linkedin") {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn Ads requires provider_options.platform=linkedin",
		);
	}
	const settings = "settings" in options ? options.settings : options.campaign;
	if (!settings) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn campaign settings are required when creating a campaign hierarchy",
		);
	}
	return settings;
}

function linkedinCreativeSettings(params: {
	providerOptions?: AdCreateProviderOptions;
}): LinkedinCreativeSettings {
	const options = params.providerOptions;
	if (options?.platform !== "linkedin") {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn Ads requires an existing-content creative reference",
		);
	}
	return options.creative;
}

function linkedinEpoch(value: string | undefined, field: string): number {
	if (!value) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			`LinkedIn campaigns require ${field}`,
		);
	}
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch)) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			`LinkedIn ${field} must be an ISO-8601 timestamp`,
		);
	}
	return epoch;
}

function validateLinkedinCampaign(params: {
	objective?: string;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	currency?: string;
	startDate?: string;
	endDate?: string;
	providerOptions?: AdCampaignProviderOptions | AdCreateProviderOptions;
}): void {
	const settings = linkedinCampaignSettings(params);
	if (
		!params.objective ||
		![
			"awareness",
			"traffic",
			"engagement",
			"leads",
			"conversions",
			"video_views",
		].includes(params.objective)
	) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"The Relay objective is not supported by LinkedIn Sponsored Updates",
		);
	}
	if (
		params.dailyBudgetCents === undefined &&
		params.lifetimeBudgetCents === undefined
	) {
		throw new AdPlatformError(
			"INVALID_BUDGET",
			"LinkedIn campaigns require a daily or lifetime budget",
		);
	}
	if (!params.currency || !/^[A-Z]{3}$/.test(params.currency)) {
		throw new AdPlatformError(
			"INVALID_CURRENCY",
			"LinkedIn campaign budgets require the ad account's ISO currency",
		);
	}
	const start = linkedinEpoch(params.startDate, "start_date");
	if (
		params.lifetimeBudgetCents !== undefined &&
		params.dailyBudgetCents === undefined &&
		!params.endDate
	) {
		throw new AdPlatformError(
			"INVALID_BUDGET",
			"LinkedIn total-budget-only campaigns require end_date",
		);
	}
	if (params.endDate && linkedinEpoch(params.endDate, "end_date") <= start) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn end_date must be later than start_date",
		);
	}
	if (params.objective === "leads" && settings.offsite_delivery_enabled) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn Lead Generation campaigns cannot enable offsite delivery",
		);
	}
	if (
		params.objective === "video_views" &&
		settings.format !== "SINGLE_VIDEO"
	) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn video_views campaigns require format=SINGLE_VIDEO",
		);
	}
}

function linkedinMoney(cents: number, currencyCode: string) {
	const whole = Math.floor(cents / 100);
	const minor = String(cents % 100).padStart(2, "0");
	return { amount: `${whole}.${minor}`, currencyCode };
}

function linkedinProviderName(value: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= 200) return value;
	const marker = value.match(/\[relay:[^\]]+\]/)?.[0];
	const suffix = marker ? ` ${marker}` : "";
	let prefix = marker ? value.replace(marker, "").trimEnd() : value;
	while (
		prefix.length > 0 &&
		encoder.encode(`${prefix}${suffix}`).byteLength > 200
	) {
		prefix = Array.from(prefix).slice(0, -1).join("").trimEnd();
	}
	const result = `${prefix}${suffix}`;
	if (!result || encoder.encode(result).byteLength > 200) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_OPTIONS",
			"LinkedIn campaign names cannot fit the provider's 200-byte limit",
		);
	}
	return result;
}

function markerFromLinkedinName(value: string): string {
	const marker = value.match(/\[relay:[^\]]+\]/)?.[0];
	if (!marker) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"The durable LinkedIn correlation marker is missing",
		);
	}
	return marker;
}

function linkedinObjectiveType(objective: string): string {
	switch (objective) {
		case "awareness":
			return "BRAND_AWARENESS";
		case "engagement":
			return "ENGAGEMENT";
		case "leads":
			return "LEAD_GENERATION";
		case "conversions":
			return "WEBSITE_CONVERSION";
		case "video_views":
			return "VIDEO_VIEW";
		default:
			return "WEBSITE_VISIT";
	}
}

function linkedinTargeting(settings: LinkedinCampaignSettings) {
	const excluded: Record<string, string[]> = {};
	for (const clause of settings.exclude ?? []) {
		excluded[clause.facet_urn] = [
			...new Set([...(excluded[clause.facet_urn] ?? []), ...clause.values]),
		];
	}
	return {
		include: {
			and: settings.include.map((clause) => ({
				or: { [clause.facet_urn]: clause.values },
			})),
		},
		...(Object.keys(excluded).length > 0 ? { exclude: { or: excluded } } : {}),
	};
}

function linkedinResource(
	value: unknown,
	entity: "sponsoredCampaign" | "sponsoredCampaignGroup" | "sponsoredCreative",
): string {
	const id = linkedinUrnId(value, entity);
	if (!id) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`LinkedIn returned an invalid ${entity} identifier`,
		);
	}
	return sponsoredUrn(entity, id);
}

async function linkedinCreate(
	credentials: AdProviderCredentials,
	path: string,
	body: Record<string, unknown>,
	entity: "sponsoredCampaign" | "sponsoredCampaignGroup" | "sponsoredCreative",
): Promise<string> {
	const { data, response } = await fetchProviderOptionalJson<unknown>({
		platform: "linkedin",
		url: `${LINKEDIN_REST_BASE}${path}`,
		init: {
			method: "POST",
			headers: {
				...linkedinHeaders(credentials),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	});
	const rawId =
		response.headers.get("x-restli-id") ?? linkedinId(objectValue(data)?.id);
	return linkedinResource(rawId, entity);
}

async function linkedinPartialUpdate(
	credentials: AdProviderCredentials,
	path: string,
	fields: Record<string, unknown>,
): Promise<void> {
	if (Object.keys(fields).length === 0) return;
	await fetchProviderOptionalJson<unknown>({
		platform: "linkedin",
		url: `${LINKEDIN_REST_BASE}${path}`,
		init: {
			method: "POST",
			headers: {
				...linkedinHeaders(credentials),
				"Content-Type": "application/json",
				"X-RestLi-Method": "PARTIAL_UPDATE",
			},
			body: JSON.stringify({ patch: { $set: fields } }),
		},
	});
}

async function linkedinDelete(
	credentials: AdProviderCredentials,
	path: string,
): Promise<void> {
	await fetchProviderOptionalJson<unknown>({
		platform: "linkedin",
		url: `${LINKEDIN_REST_BASE}${path}`,
		init: { method: "DELETE", headers: linkedinHeaders(credentials) },
	});
}

async function linkedinGet(
	credentials: AdProviderCredentials,
	path: string,
): Promise<Record<string, unknown>> {
	const { data } = await fetchProviderJson<unknown>({
		platform: "linkedin",
		url: `${LINKEDIN_REST_BASE}${path}`,
		init: { headers: linkedinHeaders(credentials) },
	});
	const row = objectValue(data);
	if (!row) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"LinkedIn returned a non-object resource",
		);
	}
	return row;
}

function linkedinEntityId(value: string, entity: string): string {
	const id = linkedinUrnId(value, entity);
	if (!id) {
		throw new AdPlatformError(
			"INVALID_PROVIDER_RESOURCE",
			`LinkedIn requires a canonical ${entity} resource`,
		);
	}
	return id;
}

function canonicalLinkedinStatus(value: unknown): string | undefined {
	switch (stringValue(value)?.toUpperCase()) {
		case "ACTIVE":
			return "ACTIVE";
		case "DRAFT":
		case "PAUSED":
			return "PAUSED";
		case "CANCELED":
		case "ARCHIVED":
		case "PENDING_DELETION":
		case "REMOVED":
			return "DELETED";
		default:
			return stringValue(value)?.toUpperCase();
	}
}

async function linkedinCreativeRow(
	credentials: AdProviderCredentials,
	accountId: string,
	creativeUrn: string,
): Promise<Record<string, unknown> | undefined> {
	const rows = await linkedinSearch(
		credentials,
		`/adAccounts/${encodeURIComponent(accountId)}/creatives`,
		{
			q: "criteria",
			creatives: `List(${creativeUrn})`,
			sortOrder: "ASCENDING",
		},
		{ "X-RestLi-Method": "FINDER" },
	);
	return rows.find(
		(row) =>
			linkedinUrnId(row.id, "sponsoredCreative") ===
			linkedinUrnId(creativeUrn, "sponsoredCreative"),
	);
}

async function linkedinCampaignRow(
	credentials: AdProviderCredentials,
	accountId: string,
	campaignUrn: string,
): Promise<Record<string, unknown>> {
	const id = linkedinEntityId(campaignUrn, "sponsoredCampaign");
	return linkedinGet(
		credentials,
		`/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(id)}`,
	);
}

async function linkedinCampaignGroupRow(
	credentials: AdProviderCredentials,
	accountId: string,
	groupUrn: string,
): Promise<Record<string, unknown>> {
	const id = linkedinEntityId(groupUrn, "sponsoredCampaignGroup");
	return linkedinGet(
		credentials,
		`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(id)}`,
	);
}

function linkedinCurrency(row: Record<string, unknown>): string | undefined {
	for (const field of ["dailyBudget", "totalBudget", "unitCost"] as const) {
		const currency = stringValue(objectValue(row[field])?.currencyCode);
		if (currency) return currency;
	}
	return undefined;
}

async function linkedinCampaignCurrency(
	credentials: AdProviderCredentials,
	accountId: string,
	row: Record<string, unknown>,
): Promise<string> {
	const fromCampaign = linkedinCurrency(row);
	if (fromCampaign) return fromCampaign;
	const account = await linkedinGet(
		credentials,
		`/adAccounts/${encodeURIComponent(accountId)}`,
	);
	const currency = stringValue(account.currency);
	if (!currency) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"LinkedIn did not return the ad account currency required for a budget mutation",
		);
	}
	return currency;
}

async function findLinkedinCreativeAndAd(
	accessToken: string,
	adAccountId: string,
	params: FindCreatedAdObjectParams,
	providerCredentials?: AdProviderCredentials,
): Promise<{ creativeId: string; adId: string } | null> {
	const accountId = normalizeLinkedinAccountId(adAccountId);
	const credentials = linkedinWriteCredentials(
		accessToken,
		accountId,
		providerCredentials,
	);
	const rows = await linkedinSearch(
		credentials,
		`/adAccounts/${encodeURIComponent(accountId)}/creatives`,
		{
			q: "criteria",
			sortOrder: "ASCENDING",
			...(params.platformAdSetId
				? { campaigns: `List(${params.platformAdSetId})` }
				: {}),
		},
		{ "X-RestLi-Method": "FINDER" },
	);
	for (const row of rows) {
		if (!stringValue(row.name)?.includes(params.marker)) continue;
		const creativeId = linkedinResource(row.id, "sponsoredCreative");
		return { creativeId, adId: creativeId };
	}
	return null;
}

const linkedinCreation: AdProviderCreationAdapter = {
	coalescesCreativeAndAd: true,

	async createCampaign(accessToken, adAccountId, params, providerCredentials) {
		validateLinkedinCampaign(params);
		markerFromLinkedinName(params.name);
		const accountId = normalizeLinkedinAccountId(adAccountId);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const start = linkedinEpoch(params.startDate, "start_date");
		const body: Record<string, unknown> = {
			account: `urn:li:sponsoredAccount:${accountId}`,
			name: linkedinProviderName(params.name),
			runSchedule: {
				start,
				...(params.endDate
					? { end: linkedinEpoch(params.endDate, "end_date") }
					: {}),
			},
			// Campaign groups can only be created ACTIVE or DRAFT. DRAFT is the
			// provider's absolute non-serving state and is canonicalized to PAUSED.
			status: "DRAFT",
		};
		return linkedinCreate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups`,
			body,
			"sponsoredCampaignGroup",
		);
	},

	async createAdSet(accessToken, adAccountId, params, providerCredentials) {
		validateLinkedinCampaign(params);
		const accountId = normalizeLinkedinAccountId(adAccountId);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const campaignGroup = linkedinResource(
			params.campaignId,
			"sponsoredCampaignGroup",
		);
		const settings = linkedinCampaignSettings(params);
		const currency = params.currency ?? "";
		const body: Record<string, unknown> = {
			account: `urn:li:sponsoredAccount:${accountId}`,
			campaignGroup,
			associatedEntity: settings.associated_entity,
			audienceExpansionEnabled: settings.audience_expansion_enabled,
			connectedTelevisionOnly: false,
			costType: settings.cost_type,
			creativeSelection: "OPTIMIZED",
			locale: settings.locale,
			name: linkedinProviderName(params.name),
			objectiveType: linkedinObjectiveType(params.objective ?? ""),
			offsiteDeliveryEnabled: settings.offsite_delivery_enabled,
			politicalIntent: settings.political_intent,
			runSchedule: {
				start: linkedinEpoch(params.startDate, "start_date"),
				...(params.endDate
					? { end: linkedinEpoch(params.endDate, "end_date") }
					: {}),
			},
			status: "DRAFT",
			targetingCriteria: linkedinTargeting(settings),
			type: "SPONSORED_UPDATES",
			unitCost: linkedinMoney(settings.unit_cost_cents, currency),
			...(settings.format ? { format: settings.format } : {}),
			...(params.dailyBudgetCents !== undefined
				? {
						dailyBudget: linkedinMoney(params.dailyBudgetCents, currency),
					}
				: {}),
			...(params.lifetimeBudgetCents !== undefined
				? {
						totalBudget: linkedinMoney(params.lifetimeBudgetCents, currency),
						pacingStrategy: "LIFETIME",
					}
				: {}),
		};
		return linkedinCreate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaigns`,
			body,
			"sponsoredCampaign",
		);
	},

	async createCreative() {
		throw new AdPlatformError(
			"INVALID_STATE",
			"A LinkedIn sponsored creative is the billable ad and is created atomically",
		);
	},

	async createAd() {
		throw new AdPlatformError(
			"INVALID_STATE",
			"A LinkedIn sponsored creative is the billable ad and is created atomically",
		);
	},

	async createCreativeAndAd(
		accessToken: string,
		adAccountId: string,
		creative: CreateCreativeParams,
		ad: CreatePlatformAdParams,
		providerCredentials?: AdProviderCredentials,
	) {
		const accountId = normalizeLinkedinAccountId(adAccountId);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const settings = linkedinCreativeSettings(creative);
		const campaign = linkedinResource(ad.adSetId, "sponsoredCampaign");
		const creativeId = await linkedinCreate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/creatives`,
			{
				campaign,
				content: { reference: settings.content_reference },
				intendedStatus: ad.active ? "ACTIVE" : "DRAFT",
				name: linkedinProviderName(creative.name),
			},
			"sponsoredCreative",
		);
		return { creativeId, adId: creativeId };
	},

	findCreatedCreativeAndAd: findLinkedinCreativeAndAd,

	async findCreatedObject(
		accessToken: string,
		adAccountId: string,
		params: FindCreatedAdObjectParams,
		providerCredentials?: AdProviderCredentials,
	) {
		if (params.phase === "creative" || params.phase === "ad") {
			const pair = await findLinkedinCreativeAndAd(
				accessToken,
				adAccountId,
				params,
				providerCredentials,
			);
			return pair?.adId ?? null;
		}
		const accountId = normalizeLinkedinAccountId(adAccountId);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const rows = await linkedinSearch(
			credentials,
			params.phase === "campaign"
				? `/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups`
				: `/adAccounts/${encodeURIComponent(accountId)}/adCampaigns`,
			{
				q: "search",
				search:
					params.phase === "campaign"
						? `(status:(values:List(${CAMPAIGN_GROUP_STATUSES})))`
						: `(status:(values:List(${CAMPAIGN_STATUSES})))`,
			},
		);
		for (const row of rows) {
			if (!stringValue(row.name)?.includes(params.marker)) continue;
			return linkedinResource(
				row.id,
				params.phase === "campaign"
					? "sponsoredCampaignGroup"
					: "sponsoredCampaign",
			);
		}
		return null;
	},

	async activateBoost(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		_refresh,
		providerCredentials,
	) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const groupId = linkedinEntityId(
			platformCampaignId,
			"sponsoredCampaignGroup",
		);
		const campaignId = linkedinEntityId(platformAdSetId, "sponsoredCampaign");
		// LinkedIn has no cross-resource atomic activation. Group-first cannot
		// spend while the child campaign remains DRAFT/PAUSED. The enclosing
		// durable fence reconciles both states and never blindly replays.
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(groupId)}`,
			{ status: "ACTIVE" },
		);
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
			{ status: "ACTIVE" },
		);
	},

	async isBoostActivated(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		providerCredentials,
	) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const [group, campaign] = await Promise.all([
			linkedinCampaignGroupRow(credentials, accountId, platformCampaignId),
			linkedinCampaignRow(credentials, accountId, platformAdSetId),
		]);
		return group.status === "ACTIVE" && campaign.status === "ACTIVE";
	},
};

const base = unsupportedAdAdapter("linkedin", capabilities);

export const linkedinAdAdapter: AdPlatformAdapter = {
	...base,
	creation: linkedinCreation,
	validateCreateCampaign(params) {
		validateLinkedinCampaign(params);
	},
	validateCreateAd(params) {
		linkedinCreativeSettings(params);
		if (!params.campaignId) {
			validateLinkedinCampaign(params);
		}
	},
	validateMutation(payload: AdProviderMutationPreflight) {
		if (payload.kind === "update_ad" && payload.changes?.targeting) {
			throw new AdPlatformError(
				"UNSUPPORTED_MUTATION",
				"LinkedIn targeting updates require provider-native targetingCriteria and cannot use Relay's generic targeting patch",
			);
		}
		if (
			payload.changes?.name !== undefined &&
			new TextEncoder().encode(payload.changes.name).byteLength > 200
		) {
			throw new AdPlatformError(
				"INVALID_PROVIDER_OPTIONS",
				"LinkedIn campaign and creative names are limited to 200 UTF-8 bytes",
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
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const creativeUrn = linkedinResource(platformAdId, "sponsoredCreative");
		let creative: Record<string, unknown> | undefined;
		if (
			params.status === "paused" ||
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			creative = await linkedinCreativeRow(credentials, accountId, creativeUrn);
			if (!creative) {
				throw new AdPlatformError(
					"INVALID_PROVIDER_RESOURCE",
					"The LinkedIn sponsored creative no longer exists",
				);
			}
		}
		const creativeFields: Record<string, unknown> = {};
		if (params.name !== undefined) {
			creativeFields.name = params.name;
		}
		if (
			params.status !== undefined &&
			!(params.status === "paused" && creative?.intendedStatus === "DRAFT")
		) {
			creativeFields.intendedStatus =
				params.status === "active" ? "ACTIVE" : "PAUSED";
		}
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/creatives/${encodeURIComponent(creativeUrn)}`,
			creativeFields,
		);

		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			const campaignUrn = linkedinResource(
				creative?.campaign,
				"sponsoredCampaign",
			);
			const campaign = await linkedinCampaignRow(
				credentials,
				accountId,
				campaignUrn,
			);
			const currency = await linkedinCampaignCurrency(
				credentials,
				accountId,
				campaign,
			);
			await linkedinPartialUpdate(
				credentials,
				`/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(linkedinEntityId(campaignUrn, "sponsoredCampaign"))}`,
				{
					...(params.dailyBudgetCents !== undefined
						? {
								dailyBudget: linkedinMoney(params.dailyBudgetCents, currency),
							}
						: {}),
					...(params.lifetimeBudgetCents !== undefined
						? {
								totalBudget: linkedinMoney(
									params.lifetimeBudgetCents,
									currency,
								),
							}
						: {}),
				},
			);
		}
	},
	async updateCampaign(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		params,
		providerCredentials,
	) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const groupId = linkedinEntityId(
			platformCampaignId,
			"sponsoredCampaignGroup",
		);
		if (params.name !== undefined) {
			await linkedinPartialUpdate(
				credentials,
				`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(groupId)}`,
				{ name: params.name },
			);
		}
		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			if (!platformAdSetId) {
				throw new AdPlatformError(
					"INVALID_STATE",
					"The LinkedIn campaign has no sponsored campaign for its budget mutation",
				);
			}
			const campaignId = linkedinEntityId(platformAdSetId, "sponsoredCampaign");
			const campaign = await linkedinCampaignRow(
				credentials,
				accountId,
				platformAdSetId,
			);
			const currency = await linkedinCampaignCurrency(
				credentials,
				accountId,
				campaign,
			);
			await linkedinPartialUpdate(
				credentials,
				`/adAccounts/${encodeURIComponent(accountId)}/adCampaigns/${encodeURIComponent(campaignId)}`,
				{
					...(params.dailyBudgetCents !== undefined
						? {
								dailyBudget: linkedinMoney(params.dailyBudgetCents, currency),
							}
						: {}),
					...(params.lifetimeBudgetCents !== undefined
						? {
								totalBudget: linkedinMoney(
									params.lifetimeBudgetCents,
									currency,
								),
							}
						: {}),
				},
			);
		}
	},
	async inspectAdMutation(
		accessToken,
		platformAdId,
		providerCredentials,
	): Promise<AdProviderMutationState> {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const creativeUrn = linkedinResource(platformAdId, "sponsoredCreative");
		const creative = await linkedinCreativeRow(
			credentials,
			accountId,
			creativeUrn,
		);
		if (!creative) return { exists: false };
		const campaignUrn = linkedinResource(
			creative.campaign,
			"sponsoredCampaign",
		);
		const campaign = await linkedinCampaignRow(
			credentials,
			accountId,
			campaignUrn,
		);
		return {
			exists: true,
			name: stringValue(creative.name),
			status: canonicalLinkedinStatus(creative.intendedStatus),
			adSetId: campaignUrn,
			dailyBudgetCents: linkedinMoneyCents(campaign.dailyBudget) ?? null,
			lifetimeBudgetCents: linkedinMoneyCents(campaign.totalBudget) ?? null,
			targeting: objectValue(campaign.targetingCriteria) ?? undefined,
		};
	},
	async inspectCampaignMutation(
		accessToken,
		platformCampaignId,
		platformAdSetId,
		providerCredentials,
	): Promise<CampaignProviderMutationState> {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const group = await linkedinCampaignGroupRow(
			credentials,
			accountId,
			platformCampaignId,
		);
		const campaign = platformAdSetId
			? await linkedinCampaignRow(credentials, accountId, platformAdSetId)
			: undefined;
		return {
			exists: true,
			name: stringValue(group.name),
			status: canonicalLinkedinStatus(group.status),
			adSetStatus: canonicalLinkedinStatus(campaign?.status),
			dailyBudgetCents: linkedinMoneyCents(campaign?.dailyBudget) ?? null,
			lifetimeBudgetCents: linkedinMoneyCents(campaign?.totalBudget) ?? null,
		};
	},
	async pauseAd(accessToken, platformAdId, providerCredentials) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const creativeUrn = linkedinResource(platformAdId, "sponsoredCreative");
		const creative = await linkedinCreativeRow(
			credentials,
			accountId,
			creativeUrn,
		);
		if (!creative) {
			throw new AdPlatformError(
				"INVALID_PROVIDER_RESOURCE",
				"The LinkedIn sponsored creative no longer exists",
			);
		}
		if (creative.intendedStatus === "DRAFT") return;
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/creatives/${encodeURIComponent(creativeUrn)}`,
			{ intendedStatus: "PAUSED" },
		);
	},
	async resumeAd(accessToken, platformAdId, providerCredentials) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const creativeUrn = linkedinResource(platformAdId, "sponsoredCreative");
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/creatives/${encodeURIComponent(creativeUrn)}`,
			{ intendedStatus: "ACTIVE" },
		);
	},
	async cancelAd(accessToken, platformAdId, providerCredentials) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const creativeUrn = linkedinResource(platformAdId, "sponsoredCreative");
		const path = `/adAccounts/${encodeURIComponent(accountId)}/creatives/${encodeURIComponent(creativeUrn)}`;
		const creative = await linkedinCreativeRow(
			credentials,
			accountId,
			creativeUrn,
		);
		if (!creative) return;
		if (creative.intendedStatus === "DRAFT") {
			await linkedinDelete(credentials, path);
			return;
		}
		await linkedinPartialUpdate(credentials, path, {
			intendedStatus: "PENDING_DELETION",
		});
	},
	async pauseCampaign(accessToken, platformCampaignId, providerCredentials) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		const group = await linkedinCampaignGroupRow(
			credentials,
			accountId,
			platformCampaignId,
		);
		if (group.status === "DRAFT") return;
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(linkedinEntityId(platformCampaignId, "sponsoredCampaignGroup"))}`,
			{ status: "PAUSED" },
		);
	},
	async resumeCampaign(accessToken, platformCampaignId, providerCredentials) {
		const accountId = linkedinAuthorizedAccount(providerCredentials);
		const credentials = linkedinWriteCredentials(
			accessToken,
			accountId,
			providerCredentials,
		);
		await linkedinPartialUpdate(
			credentials,
			`/adAccounts/${encodeURIComponent(accountId)}/adCampaignGroups/${encodeURIComponent(linkedinEntityId(platformCampaignId, "sponsoredCampaignGroup"))}`,
			{ status: "ACTIVE" },
		);
	},
	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const accountIds = new Set<string>();
		for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
			const start = page * 100;
			const url = new URL(`${LINKEDIN_REST_BASE}/adAccountUsers`);
			url.searchParams.set("q", "authenticatedUser");
			url.searchParams.set("start", String(start));
			url.searchParams.set("count", "100");
			const { data } = await fetchProviderJson<unknown>({
				platform: "linkedin",
				url: url.toString(),
				init: { headers: linkedinHeaders(credentials) },
			});
			const envelope = objectValue(data);
			if (!envelope) {
				throw new AdPlatformError(
					"PROVIDER_PROTOCOL_ERROR",
					"LinkedIn account discovery returned a non-object response",
				);
			}
			const elements = arrayValue(envelope.elements);
			for (const item of elements) {
				const element = objectValue(item);
				const id = sponsoredAccountId(element?.account);
				if (id) accountIds.add(id);
			}
			const paging = objectValue(envelope.paging);
			const total = Number(paging?.total ?? start + elements.length);
			if (elements.length === 0 || start + elements.length >= total) break;
		}

		const ids = [...accountIds].slice(0, 100);
		const accounts: PlatformAdAccount[] = [];
		for (let index = 0; index < ids.length; index += 5) {
			const details = await Promise.all(
				ids.slice(index, index + 5).map(async (id) => {
					const { data } = await fetchProviderJson<unknown>({
						platform: "linkedin",
						url: `${LINKEDIN_REST_BASE}/adAccounts/${encodeURIComponent(id)}`,
						init: { headers: linkedinHeaders(credentials) },
					});
					const account = objectValue(data);
					if (!account) return null;
					return {
						id,
						name: stringValue(account.name) ?? `LinkedIn Ads ${id}`,
						currency: stringValue(account.currency),
						timezone: stringValue(account.timeZone),
						status:
							stringValue(account.status)?.toUpperCase() === "ACTIVE"
								? "active"
								: "disabled",
						metadata: { provider_status: stringValue(account.status) },
					} satisfies PlatformAdAccount;
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
		const encodedAccount = encodeURIComponent(adAccountId);
		const campaignStatusSearch = `(status:(values:List(${CAMPAIGN_STATUSES})))`;
		const groupStatusSearch = `(status:(values:List(${CAMPAIGN_GROUP_STATUSES})))`;
		const [campaignGroups, campaigns, creatives] = await Promise.all([
			linkedinSearch(
				credentials,
				`/adAccounts/${encodedAccount}/adCampaignGroups`,
				{ q: "search", search: groupStatusSearch },
			),
			linkedinSearch(credentials, `/adAccounts/${encodedAccount}/adCampaigns`, {
				q: "search",
				search: campaignStatusSearch,
			}),
			linkedinSearch(
				credentials,
				`/adAccounts/${encodedAccount}/creatives`,
				{ q: "criteria", sortOrder: "ASCENDING" },
				{ "X-RestLi-Method": "FINDER" },
			),
		]);

		const groupsById = new Map(
			campaignGroups.flatMap((group) => {
				const id = linkedinUrnId(group.id, "sponsoredCampaignGroup");
				return id ? [[id, group] as const] : [];
			}),
		);
		const campaignsById = new Map(
			campaigns.flatMap((campaign) => {
				const id = linkedinUrnId(campaign.id, "sponsoredCampaign");
				return id ? [[id, campaign] as const] : [];
			}),
		);
		const ads: ExternalAdData[] = [];
		for (const creative of creatives) {
			const creativeId = linkedinId(creative.id);
			const campaignId = linkedinUrnId(creative.campaign, "sponsoredCampaign");
			if (!creativeId || !campaignId) continue;
			const campaign = campaignsById.get(campaignId);
			if (!campaign) continue;
			const campaignGroupId = linkedinUrnId(
				campaign.campaignGroup,
				"sponsoredCampaignGroup",
			);
			if (!campaignGroupId) continue;
			const group = groupsById.get(campaignGroupId);
			const schedule = objectValue(campaign.runSchedule);
			const content = objectValue(creative.content);
			ads.push({
				platformCampaignId: sponsoredUrn(
					"sponsoredCampaignGroup",
					campaignGroupId,
				),
				campaignName:
					stringValue(group?.name) ?? `Campaign group ${campaignGroupId}`,
				platformAdSetId: sponsoredUrn("sponsoredCampaign", campaignId),
				adSetName: stringValue(campaign.name) ?? `Campaign ${campaignId}`,
				platformAdId: creativeId,
				adName:
					stringValue(creative.name) ??
					stringValue(content?.reference) ??
					`Creative ${creativeId}`,
				status: linkedinStatus(creative.intendedStatus ?? campaign.status),
				objective: linkedinObjective(campaign.objectiveType),
				dailyBudgetCents: linkedinMoneyCents(campaign.dailyBudget),
				lifetimeBudgetCents: linkedinMoneyCents(campaign.totalBudget),
				startDate: linkedinDate(schedule?.start),
				endDate: linkedinDate(schedule?.end),
				targeting: objectValue(campaign.targetingCriteria) ?? undefined,
			});
		}
		return { ads, totalFound: ads.length };
	},
};
