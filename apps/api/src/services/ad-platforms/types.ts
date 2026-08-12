// ---------------------------------------------------------------------------
// Ad Platform Adapter — shared interface for all ad platform integrations
// ---------------------------------------------------------------------------

import type {
	AdCampaignProviderOptions,
	AdCreateProviderOptions,
} from "../../schemas/ad-provider-options";

export type AdPlatform =
	| "meta"
	| "google"
	| "tiktok"
	| "linkedin"
	| "pinterest"
	| "twitter";

export type AdCapabilityState =
	| "supported"
	| "requires_approval"
	| "unsupported";

export interface AdCapability {
	state: AdCapabilityState;
	reason?: string;
}

export type AdPlatformOperation =
	| "account_discovery"
	| "external_sync"
	| "analytics"
	| "campaign_create"
	| "ad_create"
	| "boost"
	| "mutation"
	| "targeting_search"
	| "audience_discovery"
	| "audience_create"
	| "audience_upload";

/**
 * Static implementation truth for an adapter. Provider credentials, account
 * roles, and product reviews are checked separately at each provider boundary.
 */
export interface AdPlatformCapabilities {
	apiVersion: string;
	authProtocol: "oauth2" | "oauth1";
	requiresDedicatedConnection: true;
	requiredScopes: string[];
	operations: Record<AdPlatformOperation, AdCapability>;
	objectives: string[];
	formats: string[];
	officialDocs: string[];
}

/** Decrypted only for the lifetime of one request/Queue invocation. */
export interface AdProviderCredentials {
	accessToken: string;
	grantedScopes?: string[];
	tokenSecret?: string;
	developerToken?: string;
	clientId?: string;
	clientSecret?: string;
	loginCustomerId?: string;
	providerAdAccountId?: string;
	metadata: Record<string, unknown>;
}

export class AdPlatformError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly platformError?: unknown,
	) {
		super(message);
		this.name = "AdPlatformError";
	}
}

/**
 * Proof that the current request was rejected before it could create a local
 * projection or cross a provider boundary. The error code alone is not enough
 * evidence: the same provider-facing code can also surface after a request may
 * have been sent, so only explicit pre-operation call sites may use this type.
 */
export class AdAuthoritativeNotAppliedError extends AdPlatformError {
	constructor(error: AdPlatformError);
	constructor(code: string, message: string, platformError?: unknown);
	constructor(
		codeOrError: string | AdPlatformError,
		message?: string,
		platformError?: unknown,
	) {
		if (codeOrError instanceof AdPlatformError) {
			super(codeOrError.code, codeOrError.message, codeOrError.platformError);
		} else {
			super(codeOrError, message ?? codeOrError, platformError);
		}
		this.name = "AdAuthoritativeNotAppliedError";
	}
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DateRange {
	startDate: string; // YYYY-MM-DD
	endDate: string; // YYYY-MM-DD
}

export interface PlatformAdAccount {
	id: string;
	name: string;
	currency?: string;
	timezone?: string;
	/** Relay-local authority state; provider-native status belongs in metadata. */
	status?: "active" | "disabled";
	metadata?: Record<string, unknown>;
}

/**
 * A Page an ad account is permitted to promote, plus the Instagram business
 * account connected to that Page (if any). Used to scope which connected
 * social accounts' posts can be boosted through a given ad account.
 */
export interface PromotablePage {
	pageId: string;
	name?: string;
	instagramBusinessAccountId?: string;
}

export interface CreateCampaignParams {
	name: string;
	objective: string;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	currency?: string;
	startDate?: string;
	endDate?: string;
	specialAdCategories?: string[];
	metadata?: Record<string, unknown>;
	providerOptions?: AdCampaignProviderOptions | AdCreateProviderOptions;
}

export interface CreateAdSetParams {
	campaignId: string;
	name: string;
	objective: string;
	currency?: string;
	mode: "standard" | "boost";
	targeting?: AdTargeting;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	startDate?: string;
	endDate?: string;
	bidAmount?: number;
	pixelId?: string;
	providerOptions?: AdCampaignProviderOptions | AdCreateProviderOptions;
}

export interface CreateCreativeParams {
	name: string;
	headline?: string;
	body?: string;
	callToAction?: string;
	linkUrl?: string;
	imageUrl?: string;
	videoUrl?: string;
	platformPostId?: string;
	urlTags?: string;
	providerOptions?: AdCreateProviderOptions;
}

export interface CreatePlatformAdParams {
	adSetId: string;
	creativeId: string;
	name: string;
	active: boolean;
	providerOptions?: AdCreateProviderOptions;
}

export type AdProviderObjectPhase = "campaign" | "ad_set" | "creative" | "ad";

export interface FindCreatedAdObjectParams {
	phase: AdProviderObjectPhase;
	marker: string;
	platformCampaignId?: string;
	platformAdSetId?: string;
	platformCreativeId?: string;
}

/** Atomic provider calls used by the durable paid-object state machine. */
export interface AdProviderCreationAdapter {
	/**
	 * Providers whose creative is the billable ad can persist both IDs from one
	 * fenced request instead of inventing a second, non-atomic provider phase.
	 */
	readonly coalescesCreativeAndAd?: true;

	createCampaign(
		accessToken: string,
		adAccountId: string,
		params: CreateCampaignParams,
		credentials?: AdProviderCredentials,
	): Promise<string>;

	createAdSet(
		accessToken: string,
		adAccountId: string,
		params: CreateAdSetParams,
		credentials?: AdProviderCredentials,
	): Promise<string>;

	createCreative(
		accessToken: string,
		adAccountId: string,
		params: CreateCreativeParams,
		credentials?: AdProviderCredentials,
	): Promise<string>;

	createAd(
		accessToken: string,
		adAccountId: string,
		params: CreatePlatformAdParams,
		credentials?: AdProviderCredentials,
	): Promise<string>;

	createCreativeAndAd?(
		accessToken: string,
		adAccountId: string,
		creative: CreateCreativeParams,
		ad: CreatePlatformAdParams,
		credentials?: AdProviderCredentials,
	): Promise<{ creativeId: string; adId: string }>;

	/** Correlate both provider IDs after an ambiguous atomic creative/ad call. */
	findCreatedCreativeAndAd?(
		accessToken: string,
		adAccountId: string,
		params: FindCreatedAdObjectParams,
		credentials?: AdProviderCredentials,
	): Promise<{ creativeId: string; adId: string } | null>;

	findCreatedObject(
		accessToken: string,
		adAccountId: string,
		params: FindCreatedAdObjectParams,
		credentials?: AdProviderCredentials,
	): Promise<string | null>;

	/** Setting these absolute states is safe to repeat after an ambiguous response. */
	activateBoost(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string,
		refreshAccessTokenBeforeAdSet?: () => Promise<string>,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	isBoostActivated(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string,
		credentials?: AdProviderCredentials,
	): Promise<boolean>;
}

export interface UpdateAdParams {
	name?: string;
	status?: "active" | "paused";
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	targeting?: AdTargeting;
}

export interface UpdateCampaignParams {
	name?: string;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
}

export interface AdProviderMutationState {
	exists: boolean;
	name?: string;
	status?: string;
	adSetId?: string;
	dailyBudgetCents?: number | null;
	lifetimeBudgetCents?: number | null;
	targeting?: Record<string, unknown>;
}

export interface CampaignProviderMutationState {
	exists: boolean;
	name?: string;
	status?: string;
	adSetStatus?: string;
	dailyBudgetCents?: number | null;
	lifetimeBudgetCents?: number | null;
}

export interface AdProviderMutationPreflight {
	kind: "update_ad" | "cancel_ad" | "update_campaign" | "cancel_campaign";
	platformAdId?: string;
	platformCampaignId?: string;
	platformAdSetId?: string;
	changes?: UpdateAdParams & { status?: "active" | "paused" };
}

export interface AdTargeting {
	ageMin?: number;
	ageMax?: number;
	genders?: ("male" | "female" | "all")[];
	locations?: {
		countries?: string[];
		cities?: string[];
		radiusMiles?: number;
	}[];
	interests?: { id: string; name: string }[];
	customAudiences?: string[];
	excludedAudiences?: string[];
	languages?: string[];
	placements?: string[];
	platformSpecific?: Record<string, unknown>;
}

export interface AdMetricPoint {
	date: string; // YYYY-MM-DD
	impressions: number;
	reach: number;
	clicks: number;
	spendCents: number;
	conversions: number;
	videoViews: number;
	engagement: number;
	ctr?: number;
	cpcCents?: number;
	cpmCents?: number;
}

export interface AdMetricsWithDemographics {
	daily: AdMetricPoint[];
	demographics?: {
		ageGender?: Record<string, unknown>[];
		locations?: Record<string, unknown>[];
	};
}

export interface TargetingInterest {
	id: string;
	name: string;
	category?: string;
	audienceSize?: number;
}

export interface CreateAudienceParams {
	name: string;
	type: "customer_list" | "website" | "lookalike";
	description?: string;
	// For website audiences
	pixelId?: string;
	retentionDays?: number;
	rule?: Record<string, unknown>;
	// For lookalike audiences
	sourceAudienceId?: string;
	country?: string;
	ratio?: number;
	customerFileSource?: string;
}

export interface PlatformAudienceResult {
	platformAudienceId: string;
	name: string;
	type: string;
	status: string;
	approximateSize?: number;
}

/** An existing custom audience discovered from the platform */
export interface PlatformAudience {
	/** Platform-side audience id */
	id: string;
	name: string;
	type: "customer_list" | "website" | "lookalike";
	description?: string | null;
	size?: number | null;
	status?: string | null;
}

export interface HashedUser {
	emailHash?: string;
	phoneHash?: string;
}

export interface ExternalAdData {
	platformCampaignId: string;
	campaignName: string;
	platformAdSetId?: string;
	adSetName?: string;
	platformAdId: string;
	adName: string;
	status: string;
	objective?: string;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	startDate?: string;
	endDate?: string;
	creative?: {
		headline?: string;
		body?: string;
		imageUrl?: string;
		videoUrl?: string;
		linkUrl?: string;
		callToAction?: string;
	};
	targeting?: Record<string, unknown>;
	metrics?: AdMetricPoint;
}

export interface ExternalAdSyncResult {
	ads: ExternalAdData[];
	totalFound: number;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface AdPlatformAdapter {
	readonly platform: AdPlatform;
	readonly capabilities: AdPlatformCapabilities;
	readonly creation: AdProviderCreationAdapter;
	/** Synchronous, provider-specific validation before a durable write marker. */
	validateCreateCampaign?(params: CreateCampaignParams): void;
	/** Synchronous, provider-specific validation before a durable write marker. */
	validateCreateAd?(
		params: Omit<CreateCampaignParams, "objective"> &
			CreateCreativeParams & { campaignId?: string; objective?: string },
	): void;
	/** Reject unsupported mutation shapes before opening a durable provider fence. */
	validateMutation?(payload: AdProviderMutationPreflight): void;
	/** Canonical provider payload used only for conservative reconciliation. */
	canonicalizeTargeting?(targeting: AdTargeting): Record<string, unknown>;

	/** List ad accounts associated with a social account */
	listAdAccounts(
		accessToken: string,
		platformAccountId: string,
		credentials?: AdProviderCredentials,
	): Promise<PlatformAdAccount[]>;

	/**
	 * List the Pages an ad account can promote (plus each Page's connected
	 * Instagram business account). Optional: platforms that can't express this
	 * relationship simply omit it, and discovery falls back to legacy behaviour.
	 */
	listPromotablePages?(
		accessToken: string,
		platformAdAccountId: string,
	): Promise<PromotablePage[]>;

	/** Update an ad (name, budget, targeting, status) */
	updateAd(
		accessToken: string,
		platformAdId: string,
		params: UpdateAdParams,
		refreshAccessTokenBeforeAdSet?: () => Promise<string>,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Update campaign/ad-set fields without changing delivery state. */
	updateCampaign(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string | undefined,
		params: UpdateCampaignParams,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Read canonical provider state to reconcile an ambiguous absolute mutation. */
	inspectAdMutation(
		accessToken: string,
		platformAdId: string,
		credentials?: AdProviderCredentials,
	): Promise<AdProviderMutationState>;

	/** Read canonical campaign/ad-set state for ambiguous mutation recovery. */
	inspectCampaignMutation(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId?: string,
		credentials?: AdProviderCredentials,
	): Promise<CampaignProviderMutationState>;

	/** Pause an active ad */
	pauseAd(
		accessToken: string,
		platformAdId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Resume a paused ad */
	resumeAd(
		accessToken: string,
		platformAdId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Cancel/delete an ad */
	cancelAd(
		accessToken: string,
		platformAdId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Pause all ads in a campaign */
	pauseCampaign(
		accessToken: string,
		platformCampaignId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Resume all ads in a campaign */
	resumeCampaign(
		accessToken: string,
		platformCampaignId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Get ad metrics for a date range */
	getAdMetrics(
		accessToken: string,
		platformAdId: string,
		dateRange: DateRange,
		breakdowns?: string[],
		credentials?: AdProviderCredentials,
	): Promise<AdMetricsWithDemographics>;

	/** Search targeting interests */
	searchInterests(
		accessToken: string,
		query: string,
		credentials?: AdProviderCredentials,
	): Promise<TargetingInterest[]>;

	/** List existing custom audiences for an ad account */
	listAudiences(
		accessToken: string,
		adAccountId: string,
		credentials?: AdProviderCredentials,
	): Promise<PlatformAudience[]>;

	/** Create a custom audience */
	createCustomAudience(
		accessToken: string,
		adAccountId: string,
		params: CreateAudienceParams,
		credentials?: AdProviderCredentials,
	): Promise<PlatformAudienceResult>;

	/** Upload hashed users to a customer list audience */
	addUsersToAudience(
		accessToken: string,
		platformAudienceId: string,
		users: HashedUser[],
		credentials?: AdProviderCredentials,
	): Promise<{ added: number; invalid: number }>;

	/** Delete a custom audience */
	deleteAudience(
		accessToken: string,
		platformAudienceId: string,
		credentials?: AdProviderCredentials,
	): Promise<void>;

	/** Sync external ads from the platform */
	syncExternalAds(
		accessToken: string,
		adAccountId: string,
		since?: Date,
		credentials?: AdProviderCredentials,
	): Promise<ExternalAdSyncResult>;
}

export function capabilitySupports(
	adapter: Pick<AdPlatformAdapter, "capabilities">,
	operation: AdPlatformOperation,
): boolean {
	return adapter.capabilities.operations[operation].state === "supported";
}
