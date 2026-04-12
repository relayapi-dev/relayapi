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

export interface PlatformCampaignResult {
	platformCampaignId: string;
	platformAdSetId?: string;
	status: string;
}

export interface CreateAdParams {
	campaignId: string;
	adSetId?: string;
	name: string;
	headline?: string;
	body?: string;
	callToAction?: string;
	linkUrl?: string;
	imageUrl?: string;
	videoUrl?: string;
	targeting?: AdTargeting;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	startDate?: string;
	endDate?: string;
	durationDays?: number;
	metadata?: Record<string, unknown>;
}

export interface BoostPostParams {
	platformPostId: string;
	name: string;
	objective: string;
	targeting?: AdTargeting;
	dailyBudgetCents: number;
	lifetimeBudgetCents?: number;
	currency?: string;
	durationDays: number;
	startDate?: string;
	endDate?: string;
	bidAmount?: number;
	tracking?: { pixelId?: string; urlTags?: string };
	specialAdCategories?: string[];
}

export interface PlatformAdResult {
	platformCampaignId: string;
	platformAdSetId?: string;
	platformAdId: string;
	status: string;
}

export interface UpdateAdParams {
	name?: string;
	status?: "active" | "paused";
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	targeting?: AdTargeting;
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

	/** List ad accounts associated with a social account */
	listAdAccounts(
		accessToken: string,
		platformAccountId: string,
	): Promise<PlatformAdAccount[]>;

	/** Create a campaign on the platform */
	createCampaign(
		accessToken: string,
		adAccountId: string,
		params: CreateCampaignParams,
	): Promise<PlatformCampaignResult>;

	/** Create an ad within a campaign */
	createAd(
		accessToken: string,
		adAccountId: string,
		params: CreateAdParams,
	): Promise<PlatformAdResult>;

	/** Boost an existing published post as a paid ad */
	boostPost(
		accessToken: string,
		adAccountId: string,
		params: BoostPostParams,
	): Promise<PlatformAdResult>;

	/** Update an ad (name, budget, targeting, status) */
	updateAd(
		accessToken: string,
		platformAdId: string,
		params: UpdateAdParams,
	): Promise<void>;

	/** Pause an active ad */
	pauseAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Resume a paused ad */
	resumeAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Cancel/delete an ad */
	cancelAd(accessToken: string, platformAdId: string): Promise<void>;

	/** Pause all ads in a campaign */
	pauseCampaign(
		accessToken: string,
		platformCampaignId: string,
	): Promise<void>;

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
