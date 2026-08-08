// ---------------------------------------------------------------------------
// Ad Platform Adapter — shared interface for all ad platform integrations
// ---------------------------------------------------------------------------

export type AdPlatform =
	| "meta"
	| "google"
	| "tiktok"
	| "linkedin"
	| "pinterest"
	| "twitter";

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
	status?: string;
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
}

export interface CreateAdSetParams {
	campaignId: string;
	name: string;
	mode: "standard" | "boost";
	targeting?: AdTargeting;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	startDate?: string;
	endDate?: string;
	bidAmount?: number;
	pixelId?: string;
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
}

export interface CreatePlatformAdParams {
	adSetId: string;
	creativeId: string;
	name: string;
	active: boolean;
}

export type AdProviderObjectPhase = "campaign" | "ad_set" | "creative" | "ad";

export interface FindCreatedAdObjectParams {
	phase: AdProviderObjectPhase;
	marker: string;
	platformCampaignId?: string;
	platformAdSetId?: string;
}

/** Atomic provider calls used by the durable paid-object state machine. */
export interface AdProviderCreationAdapter {
	createCampaign(
		accessToken: string,
		adAccountId: string,
		params: CreateCampaignParams,
	): Promise<string>;

	createAdSet(
		accessToken: string,
		adAccountId: string,
		params: CreateAdSetParams,
	): Promise<string>;

	createCreative(
		accessToken: string,
		adAccountId: string,
		params: CreateCreativeParams,
	): Promise<string>;

	createAd(
		accessToken: string,
		adAccountId: string,
		params: CreatePlatformAdParams,
	): Promise<string>;

	findCreatedObject(
		accessToken: string,
		adAccountId: string,
		params: FindCreatedAdObjectParams,
	): Promise<string | null>;

	/** Setting these absolute states is safe to repeat after an ambiguous response. */
	activateBoost(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string,
		refreshAccessTokenBeforeAdSet?: () => Promise<string>,
	): Promise<void>;

	isBoostActivated(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string,
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
	readonly creation: AdProviderCreationAdapter;
	/** Canonical provider payload used only for conservative reconciliation. */
	canonicalizeTargeting?(targeting: AdTargeting): Record<string, unknown>;

	/** List ad accounts associated with a social account */
	listAdAccounts(
		accessToken: string,
		platformAccountId: string,
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
	): Promise<void>;

	/** Update campaign/ad-set fields without changing delivery state. */
	updateCampaign(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId: string | undefined,
		params: UpdateCampaignParams,
	): Promise<void>;

	/** Read canonical provider state to reconcile an ambiguous absolute mutation. */
	inspectAdMutation(
		accessToken: string,
		platformAdId: string,
	): Promise<AdProviderMutationState>;

	/** Read canonical campaign/ad-set state for ambiguous mutation recovery. */
	inspectCampaignMutation(
		accessToken: string,
		platformCampaignId: string,
		platformAdSetId?: string,
	): Promise<CampaignProviderMutationState>;

	/** Pause an active ad */
	pauseAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Resume a paused ad */
	resumeAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Cancel/delete an ad */
	cancelAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Pause all ads in a campaign */
	pauseCampaign(accessToken: string, platformCampaignId: string): Promise<void>;

	/** Resume all ads in a campaign */
	resumeCampaign(
		accessToken: string,
		platformCampaignId: string,
	): Promise<void>;

	/** Get ad metrics for a date range */
	getAdMetrics(
		accessToken: string,
		platformAdId: string,
		dateRange: DateRange,
		breakdowns?: string[],
	): Promise<AdMetricsWithDemographics>;

	/** Search targeting interests */
	searchInterests(
		accessToken: string,
		query: string,
	): Promise<TargetingInterest[]>;

	/** List existing custom audiences for an ad account */
	listAudiences(
		accessToken: string,
		adAccountId: string,
	): Promise<PlatformAudience[]>;

	/** Create a custom audience */
	createCustomAudience(
		accessToken: string,
		adAccountId: string,
		params: CreateAudienceParams,
	): Promise<PlatformAudienceResult>;

	/** Upload hashed users to a customer list audience */
	addUsersToAudience(
		accessToken: string,
		platformAudienceId: string,
		users: HashedUser[],
	): Promise<{ added: number; invalid: number }>;

	/** Delete a custom audience */
	deleteAudience(
		accessToken: string,
		platformAudienceId: string,
	): Promise<void>;

	/** Sync external ads from the platform */
	syncExternalAds(
		accessToken: string,
		adAccountId: string,
		since?: Date,
	): Promise<ExternalAdSyncResult>;
}
