// X Ads API v12 adapter.
// Official sources:
// - OAuth 1.0a user-context requirement and account discovery:
//   https://docs.x.com/x-ads-api/fundamentals/accessing-ads-accounts
// - Campaign/line-item/promoted-Tweet hierarchy:
//   https://docs.x.com/x-ads-api/campaign-management/reference
// - Rate limits: https://docs.x.com/x-ads-api/fundamentals/rate-limiting

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

const X_ADS_BASE = `https://ads-api.x.com/${API_VERSIONS.twitter_ads}`;
const MAX_LIST_PAGES = 20;

const capabilities: AdPlatformCapabilities = {
	apiVersion: API_VERSIONS.twitter_ads,
	authProtocol: "oauth1",
	requiresDedicatedConnection: true,
	// OAuth 1.0a access is controlled by the app's Ads API entitlement and token
	// permissions, not OAuth 2-style scope strings stored on the connection.
	requiredScopes: [],
	operations: {
		account_discovery: { state: "supported" },
		external_sync: { state: "supported" },
		analytics: {
			state: "unsupported",
			reason:
				"X synchronous/async analytics needs account-scoped durable report jobs before it is exposed",
		},
		campaign_create: { state: "supported" },
		ad_create: { state: "supported" },
		boost: { state: "supported" },
		mutation: {
			state: "supported",
			reason:
				"X supports campaign/line-item mutations and promoted-Tweet removal; promoted-Tweet associations have no update or resume endpoint",
		},
		targeting_search: {
			state: "unsupported",
			reason:
				"X keyword insights are not interchangeable with the current interest-ID contract",
		},
		audience_discovery: {
			state: "requires_approval",
			reason: "X tailored audiences require Ads API approval",
		},
		audience_create: {
			state: "requires_approval",
			reason: "X tailored audiences require Ads API approval",
		},
		audience_upload: {
			state: "requires_approval",
			reason: "X tailored audience user upload requires Ads API approval",
		},
	},
	objectives: ["awareness", "traffic", "engagement", "video_views"],
	formats: ["existing_tweet"],
	officialDocs: [
		"https://docs.x.com/x-ads-api/fundamentals/accessing-ads-accounts",
		"https://docs.x.com/x-ads-api/campaign-management/reference",
		"https://docs.x.com/x-ads-api/campaign-management",
		"https://docs.x.com/x-ads-api/creatives",
		"https://docs.x.com/x-ads-api/fundamentals/rate-limiting",
	],
};

function credentialsOrThrow(
	accessToken: string,
	credentials?: AdProviderCredentials,
): AdProviderCredentials {
	if (
		!accessToken ||
		!credentials?.tokenSecret ||
		!credentials.clientId ||
		!credentials.clientSecret
	) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			"X Ads requires an approved OAuth 1.0a connection, token secret, and Ads consumer credentials",
		);
	}
	return { ...credentials, accessToken };
}

function percentEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function oauth1Authorization(
	method: string,
	url: URL,
	credentials: AdProviderCredentials,
): Promise<string> {
	const oauth: Record<string, string> = {
		oauth_consumer_key: credentials.clientId ?? "",
		oauth_nonce: crypto.randomUUID().replaceAll("-", ""),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(Math.floor(Date.now() / 1000)),
		oauth_token: credentials.accessToken,
		oauth_version: "1.0",
	};
	const parameters: [string, string][] = [];
	for (const [key, value] of url.searchParams.entries()) {
		parameters.push([percentEncode(key), percentEncode(value)]);
	}
	for (const [key, value] of Object.entries(oauth)) {
		parameters.push([percentEncode(key), percentEncode(value)]);
	}
	parameters.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
		leftKey === rightKey
			? leftValue.localeCompare(rightValue)
			: leftKey.localeCompare(rightKey),
	);
	const normalized = parameters
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
	const signatureBase = [
		method.toUpperCase(),
		percentEncode(baseUrl),
		percentEncode(normalized),
	].join("&");
	const signingKey = `${percentEncode(credentials.clientSecret ?? "")}&${percentEncode(credentials.tokenSecret ?? "")}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingKey),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const signature = base64(
		new Uint8Array(
			await crypto.subtle.sign(
				"HMAC",
				key,
				new TextEncoder().encode(signatureBase),
			),
		),
	);
	return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
		.join(", ")}`;
}

async function xGet(
	credentials: AdProviderCredentials,
	url: URL,
): Promise<Record<string, unknown>> {
	const authorization = await oauth1Authorization("GET", url, credentials);
	const { data } = await fetchProviderJson<unknown>({
		platform: "twitter",
		url: url.toString(),
		init: { headers: { Authorization: authorization } },
	});
	const envelope = objectValue(data);
	if (!envelope) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"X Ads returned a non-object response",
		);
	}
	if (arrayValue(envelope.errors).length > 0) {
		throw new AdPlatformError(
			"PROVIDER_API_ERROR",
			"X Ads returned one or more provider errors",
			{ errors: envelope.errors },
		);
	}
	return envelope;
}

async function xList(
	credentials: AdProviderCredentials,
	path: string,
	params: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const url = new URL(`${X_ADS_BASE}${path}`);
		url.searchParams.set("count", "200");
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		if (cursor) url.searchParams.set("cursor", cursor);
		const envelope = await xGet(credentials, url);
		for (const item of arrayValue(envelope.data)) {
			const object = objectValue(item);
			if (object) rows.push(object);
		}
		cursor = stringValue(envelope.next_cursor);
		if (!cursor || cursor === "0") break;
	}
	return rows;
}

type TwitterCampaignSettings = Extract<
	AdCampaignProviderOptions,
	{ platform: "twitter" }
>["settings"];
type TwitterCreativeSettings = Extract<
	AdCreateProviderOptions,
	{ platform: "twitter" }
>["creative"];

function invalidX(message: string): never {
	throw new AdPlatformError("INVALID_PROVIDER_OPTIONS", message);
}

function xCampaignSettings(
	options: CreateCampaignParams["providerOptions"],
): TwitterCampaignSettings {
	if (options?.platform !== "twitter") {
		return invalidX("X Ads campaign creation requires X provider_options");
	}
	const settings = "settings" in options ? options.settings : options.campaign;
	if (!settings) {
		return invalidX(
			"X campaign settings are required when creating a campaign",
		);
	}
	return settings;
}

function xCreativeSettings(
	options: CreateCreativeParams["providerOptions"],
): TwitterCreativeSettings {
	if (options?.platform !== "twitter") {
		return invalidX("X promoted Tweets require X creative provider_options");
	}
	return options.creative;
}

function xAccountId(credentials: AdProviderCredentials): string {
	if (!credentials.providerAdAccountId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"X Ads mutation requires the provider account ID",
		);
	}
	return credentials.providerAdAccountId;
}

/**
 * X Ads API v12 campaign management uses OAuth 1.0a and query parameters for
 * POST/PUT/DELETE. The signature includes every query parameter exactly as
 * documented under “Creating a campaign”, “Creating line items”, and
 * “Promoted Tweets”.
 * https://docs.x.com/x-ads-api/campaign-management/reference
 */
async function xWrite(
	credentials: AdProviderCredentials,
	method: "POST" | "PUT" | "DELETE",
	path: string,
	params: Record<string, string | number | undefined> = {},
): Promise<Record<string, unknown>> {
	const url = new URL(`${X_ADS_BASE}${path}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	const authorization = await oauth1Authorization(method, url, credentials);
	const { data } = await fetchProviderJson<unknown>({
		platform: "twitter",
		url: url.toString(),
		init: { method, headers: { Authorization: authorization } },
	});
	const envelope = objectValue(data);
	if (!envelope) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			"X Ads returned a non-object write response",
		);
	}
	if (arrayValue(envelope.errors).length > 0) {
		throw new AdPlatformError(
			"PROVIDER_API_ERROR",
			"X Ads rejected the write request",
			{ errors: envelope.errors },
		);
	}
	return envelope;
}

function xObjective(objective: string): TwitterCampaignSettings["objective"] {
	switch (objective) {
		case "awareness":
			return "REACH";
		case "traffic":
			return "WEBSITE_CLICKS";
		case "engagement":
			return "ENGAGEMENTS";
		case "video_views":
			return "VIDEO_VIEWS";
		default:
			return invalidX(
				"X Ads supports awareness, traffic, engagement, and video_views through this adapter",
			);
	}
}

function xMicros(cents: number): number {
	return cents * 10_000;
}

function xDate(value?: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return invalidX("X schedule is invalid");
	return date.toISOString();
}

function validateXCampaign(
	params: Pick<
		CreateCampaignParams,
		"objective" | "dailyBudgetCents" | "lifetimeBudgetCents" | "providerOptions"
	>,
): TwitterCampaignSettings {
	const settings = xCampaignSettings(params.providerOptions);
	const relayObjective =
		params.objective ?? invalidX("X campaign creation requires objective");
	if (settings.objective !== xObjective(relayObjective)) {
		invalidX("X line-item objective must match the selected Relay objective");
	}
	if (params.dailyBudgetCents === undefined) {
		invalidX("X Ads requires daily_budget_cents for this LINE_ITEM plan");
	}
	if (
		settings.bid_strategy !== "AUTO" &&
		settings.bid_amount_local_micro === undefined
	) {
		invalidX("X MAX and TARGET bid strategies require bid_amount_local_micro");
	}
	return settings;
}

function assertNoXTargeting(targeting?: AdTargeting): void {
	if (
		targeting &&
		Object.values(targeting).some((value) => value !== undefined)
	) {
		invalidX(
			"X targeting criteria are not implemented; set allow_worldwide_targeting=true and omit targeting",
		);
	}
}

function xDataObject(
	envelope: Record<string, unknown>,
	description: string,
): Record<string, unknown> {
	const data = objectValue(envelope.data);
	if (!data) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`X Ads did not return ${description}`,
		);
	}
	return data;
}

function xRequiredId(value: unknown, description: string): string {
	const id = stringValue(value);
	if (!id) {
		throw new AdPlatformError(
			"PROVIDER_PROTOCOL_ERROR",
			`X Ads did not return ${description}`,
		);
	}
	return id;
}

async function xEntity(
	credentials: AdProviderCredentials,
	kind: "campaigns" | "line_items" | "promoted_tweets",
	id: string,
): Promise<Record<string, unknown> | null> {
	const accountId = xAccountId(credentials);
	const filter =
		kind === "campaigns"
			? "campaign_ids"
			: kind === "line_items"
				? "line_item_ids"
				: "promoted_tweet_ids";
	const rows = await xList(
		credentials,
		`/accounts/${encodeURIComponent(accountId)}/${kind}`,
		{ [filter]: id },
	);
	return rows.find((row) => stringValue(row.id) === id) ?? null;
}

function xStatus(value: unknown): string {
	switch (stringValue(value)?.toUpperCase()) {
		case "ACTIVE":
			return "active";
		case "PAUSED":
			return "paused";
		case "DELETED":
			return "cancelled";
		case "DRAFT":
			return "draft";
		default:
			return "pending_review";
	}
}

function xMutationStatus(value: unknown): string | undefined {
	return stringValue(value)?.toUpperCase();
}

const base = unsupportedAdAdapter("twitter", capabilities);

export const twitterAdAdapter: AdPlatformAdapter = {
	...base,
	validateCreateCampaign(params: CreateCampaignParams): void {
		validateXCampaign(params);
	},
	validateCreateAd(params): void {
		const creative = xCreativeSettings(params.providerOptions);
		const tweetId = params.platformPostId ?? creative.tweet_id;
		if (!tweetId) {
			invalidX("X standalone ads require provider_options.creative.tweet_id");
		}
		if (params.campaignId) {
			invalidX(
				"X promoted-Tweet creation currently requires a new Relay campaign so ambiguous association creation can be reconciled safely",
			);
		}
		const relayObjective =
			params.objective ?? invalidX("X campaign creation requires objective");
		validateXCampaign({ ...params, objective: relayObjective });
		assertNoXTargeting(
			(params as typeof params & { targeting?: AdTargeting }).targeting,
		);
	},
	validateMutation(payload: AdProviderMutationPreflight): void {
		if (payload.kind === "update_ad") {
			invalidX(
				"X exposes no update or reversible pause/resume endpoint for promoted-Tweet associations; cancel the ad to disassociate it",
			);
		}
		if (
			payload.kind === "update_campaign" &&
			(payload.changes?.dailyBudgetCents !== undefined ||
				payload.changes?.lifetimeBudgetCents !== undefined)
		) {
			invalidX(
				"X campaign and line-item budgets require two provider effects; Relay rejects this mutation until it has a two-step durable plan",
			);
		}
	},
	canonicalizeTargeting(targeting: AdTargeting): Record<string, unknown> {
		assertNoXTargeting(targeting);
		return {};
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
			const settings = validateXCampaign(params);
			const envelope = await xWrite(
				credentials,
				"POST",
				`/accounts/${encodeURIComponent(adAccountId)}/campaigns`,
				{
					funding_instrument_id: settings.funding_instrument_id,
					name: params.name,
					daily_budget_amount_local_micro: xMicros(
						params.dailyBudgetCents ?? 0,
					),
					total_budget_amount_local_micro:
						params.lifetimeBudgetCents === undefined
							? undefined
							: xMicros(params.lifetimeBudgetCents),
					entity_status: "PAUSED",
					budget_optimization: "LINE_ITEM",
					start_time: xDate(params.startDate),
					end_time: xDate(params.endDate),
				},
			);
			return xRequiredId(
				xDataObject(envelope, "a campaign").id,
				"a campaign ID",
			);
		},
		async createAdSet(
			accessToken: string,
			adAccountId: string,
			params: CreateAdSetParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			credentials.providerAdAccountId = adAccountId;
			const settings = xCampaignSettings(params.providerOptions);
			if (params.dailyBudgetCents === undefined) {
				return invalidX("X line items require daily_budget_cents");
			}
			assertNoXTargeting(params.targeting);
			const envelope = await xWrite(
				credentials,
				"POST",
				`/accounts/${encodeURIComponent(adAccountId)}/line_items`,
				{
					campaign_id: params.campaignId,
					name: params.name,
					objective: settings.objective,
					product_type: "PROMOTED_TWEETS",
					placements: settings.placements,
					bid_strategy: settings.bid_strategy,
					bid_amount_local_micro: settings.bid_amount_local_micro,
					daily_budget_amount_local_micro: xMicros(params.dailyBudgetCents),
					entity_status: "PAUSED",
					start_time: xDate(params.startDate),
					end_time: xDate(params.endDate),
				},
			);
			return xRequiredId(
				xDataObject(envelope, "a line item").id,
				"a line-item ID",
			);
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
			const settings = xCreativeSettings(creative.providerOptions);
			const tweetId = creative.platformPostId ?? settings.tweet_id;
			if (!tweetId) return invalidX("X Ads requires a Tweet ID");
			const envelope = await xWrite(
				credentials,
				"POST",
				`/accounts/${encodeURIComponent(adAccountId)}/promoted_tweets`,
				{ line_item_id: ad.adSetId, tweet_ids: tweetId },
			);
			const rows = arrayValue(envelope.data);
			if (rows.length !== 1) {
				throw new AdPlatformError(
					"PROVIDER_PROTOCOL_ERROR",
					"X Ads did not acknowledge exactly one promoted-Tweet association",
				);
			}
			const row = objectValue(rows[0]);
			return {
				creativeId: tweetId,
				adId: xRequiredId(row?.id, "a promoted-Tweet association ID"),
			};
		},
		async findCreatedCreativeAndAd(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<{ creativeId: string; adId: string } | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			if (!params.platformAdSetId) return null;
			const rows = await xList(
				credentials,
				`/accounts/${encodeURIComponent(adAccountId)}/promoted_tweets`,
				{ line_item_ids: params.platformAdSetId },
			);
			if (rows.length !== 1) return null;
			const adId = stringValue(rows[0]?.id);
			const tweetId = stringValue(rows[0]?.tweet_id);
			return adId && tweetId ? { creativeId: tweetId, adId } : null;
		},
		async findCreatedObject(
			accessToken: string,
			adAccountId: string,
			params: FindCreatedAdObjectParams,
			providerCredentials?: AdProviderCredentials,
		): Promise<string | null> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const kind = params.phase === "campaign" ? "campaigns" : "line_items";
			const rows = await xList(
				credentials,
				`/accounts/${encodeURIComponent(adAccountId)}/${kind}`,
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
			const accountId = xAccountId(credentials);
			await xWrite(
				credentials,
				"PUT",
				`/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(platformCampaignId)}`,
				{ entity_status: "ACTIVE" },
			);
			const refreshedToken = refreshAccessTokenBeforeAdSet
				? await refreshAccessTokenBeforeAdSet()
				: accessToken;
			await xWrite(
				{ ...credentials, accessToken: refreshedToken },
				"PUT",
				`/accounts/${encodeURIComponent(accountId)}/line_items/${encodeURIComponent(platformAdSetId)}`,
				{ entity_status: "ACTIVE" },
			);
		},
		async isBoostActivated(
			accessToken: string,
			platformCampaignId: string,
			platformAdSetId: string,
			providerCredentials?: AdProviderCredentials,
		): Promise<boolean> {
			const credentials = credentialsOrThrow(accessToken, providerCredentials);
			const [campaign, lineItem] = await Promise.all([
				xEntity(credentials, "campaigns", platformCampaignId),
				xEntity(credentials, "line_items", platformAdSetId),
			]);
			return (
				campaign?.entity_status === "ACTIVE" &&
				lineItem?.entity_status === "ACTIVE"
			);
		},
	},
	async updateAd(
		_accessToken: string,
		_platformAdId: string,
		_params: UpdateAdParams,
	): Promise<void> {
		return invalidX(
			"X promoted-Tweet associations do not expose an update endpoint",
		);
	},
	async updateCampaign(
		accessToken: string,
		platformCampaignId: string,
		_platformAdSetId: string | undefined,
		params: UpdateCampaignParams,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		if (
			params.dailyBudgetCents !== undefined ||
			params.lifetimeBudgetCents !== undefined
		) {
			return invalidX(
				"X budget mutation requires a separate durable campaign/line-item plan",
			);
		}
		if (params.name === undefined) return;
		const accountId = xAccountId(credentials);
		await xWrite(
			credentials,
			"PUT",
			`/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(platformCampaignId)}`,
			{ name: params.name },
		);
	},
	async inspectAdMutation(
		accessToken: string,
		platformAdId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<AdProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const association = await xEntity(
			credentials,
			"promoted_tweets",
			platformAdId,
		);
		if (!association || association.deleted === true) return { exists: false };
		return {
			exists: true,
			status: xMutationStatus(association.entity_status),
			adSetId: stringValue(association.line_item_id),
		};
	},
	async inspectCampaignMutation(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId?: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<CampaignProviderMutationState> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const campaign = await xEntity(
			credentials,
			"campaigns",
			platformCampaignId,
		);
		if (!campaign || campaign.deleted === true) return { exists: false };
		const lineItem = platformAdSetId
			? await xEntity(credentials, "line_items", platformAdSetId)
			: null;
		const daily = numberValue(lineItem?.daily_budget_amount_local_micro);
		const total = numberValue(lineItem?.total_budget_amount_local_micro);
		return {
			exists: true,
			name: stringValue(campaign.name),
			status: xMutationStatus(campaign.entity_status),
			adSetStatus: lineItem
				? xMutationStatus(lineItem.entity_status)
				: undefined,
			dailyBudgetCents: daily === undefined ? null : Math.round(daily / 10_000),
			lifetimeBudgetCents:
				total === undefined ? null : Math.round(total / 10_000),
		};
	},
	async pauseAd(): Promise<void> {
		return invalidX(
			"X has no reversible promoted-Tweet pause endpoint; cancel to disassociate",
		);
	},
	async resumeAd(): Promise<void> {
		// Campaign resume calls this after reactivating the campaign and line item.
		// The promoted-Tweet association was never paused or deleted, so no provider
		// effect is required and inventing a PUT would call a nonexistent endpoint.
	},
	async cancelAd(
		accessToken: string,
		platformAdId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const accountId = xAccountId(credentials);
		await xWrite(
			credentials,
			"DELETE",
			`/accounts/${encodeURIComponent(accountId)}/promoted_tweets/${encodeURIComponent(platformAdId)}`,
		);
	},
	async pauseCampaign(
		accessToken: string,
		platformCampaignId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const accountId = xAccountId(credentials);
		await xWrite(
			credentials,
			"PUT",
			`/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(platformCampaignId)}`,
			{ entity_status: "PAUSED" },
		);
	},
	async resumeCampaign(
		accessToken: string,
		platformCampaignId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<void> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const accountId = xAccountId(credentials);
		await xWrite(
			credentials,
			"PUT",
			`/accounts/${encodeURIComponent(accountId)}/campaigns/${encodeURIComponent(platformCampaignId)}`,
			{ entity_status: "ACTIVE" },
		);
	},
	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
		providerCredentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]> {
		const credentials = credentialsOrThrow(accessToken, providerCredentials);
		const rows = await xList(credentials, "/accounts");
		return rows.flatMap((account) => {
			const id = stringValue(account.id);
			if (!id) return [];
			return [
				{
					id,
					name: stringValue(account.name) ?? `X Ads ${id}`,
					currency: stringValue(account.currency),
					timezone: stringValue(account.timezone),
					status: account.deleted === true ? "disabled" : "active",
					metadata: { provider_status: stringValue(account.entity_status) },
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
		const encodedAccount = encodeURIComponent(adAccountId);
		const [campaignRows, lineItemRows, promotedTweetRows] = await Promise.all([
			xList(credentials, `/accounts/${encodedAccount}/campaigns`),
			xList(credentials, `/accounts/${encodedAccount}/line_items`),
			xList(credentials, `/accounts/${encodedAccount}/promoted_tweets`),
		]);
		const campaigns = new Map(
			campaignRows
				.map((row) => [stringValue(row.id), row] as const)
				.filter((entry): entry is [string, Record<string, unknown>] =>
					Boolean(entry[0]),
				),
		);
		const lineItems = new Map(
			lineItemRows
				.map((row) => [stringValue(row.id), row] as const)
				.filter((entry): entry is [string, Record<string, unknown>] =>
					Boolean(entry[0]),
				),
		);
		const ads: ExternalAdData[] = [];
		for (const row of promotedTweetRows) {
			const lineItemId = stringValue(row.line_item_id);
			const tweetId = stringValue(row.tweet_id);
			if (!lineItemId || !tweetId) continue;
			const lineItem = lineItems.get(lineItemId);
			const campaignId = stringValue(lineItem?.campaign_id);
			if (!campaignId) continue;
			const campaign = campaigns.get(campaignId);
			const dailyBudgetMicros = numberValue(
				campaign?.daily_budget_amount_local_micro,
			);
			ads.push({
				platformCampaignId: campaignId,
				campaignName: stringValue(campaign?.name) ?? `Campaign ${campaignId}`,
				platformAdSetId: lineItemId,
				adSetName: stringValue(lineItem?.name),
				platformAdId: stringValue(row.id) ?? `${lineItemId}:${tweetId}`,
				adName: `Promoted Tweet ${tweetId}`,
				status: xStatus(row.entity_status ?? lineItem?.entity_status),
				objective: stringValue(lineItem?.objective)
					?.toUpperCase()
					.includes("VIDEO")
					? "video_views"
					: "engagement",
				dailyBudgetCents:
					dailyBudgetMicros === undefined
						? undefined
						: Math.round(dailyBudgetMicros / 10_000),
			});
		}
		return { ads, totalFound: ads.length };
	},
};
