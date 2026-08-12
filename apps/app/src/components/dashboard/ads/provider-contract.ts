export const AD_PLATFORMS = [
	"meta",
	"google",
	"tiktok",
	"linkedin",
	"pinterest",
	"twitter",
] as const;

export type AdPlatform = (typeof AD_PLATFORMS)[number];
export type AdCapabilityState =
	| "supported"
	| "requires_approval"
	| "unsupported";
export type AdWriteOperation =
	| "campaign_create"
	| "ad_create"
	| "boost"
	| "audience_create"
	| "audience_upload";
export type AdProviderOptionsMode = "campaign" | "ad" | "boost";

export interface AdCapability {
	state: AdCapabilityState;
	reason?: string;
}

export interface AdPlatformCapabilities {
	platform: AdPlatform;
	operations: Record<string, AdCapability>;
	objectives: string[];
}

export interface AdAccountCapabilities {
	platform: string;
	capabilities?: Record<string, AdCapability>;
}

const FALLBACK_OBJECTIVES: Record<AdPlatform, readonly string[]> = {
	meta: [
		"awareness",
		"traffic",
		"engagement",
		"leads",
		"conversions",
		"video_views",
	],
	google: ["traffic", "conversions"],
	tiktok: ["awareness", "traffic", "video_views"],
	linkedin: [
		"awareness",
		"traffic",
		"engagement",
		"leads",
		"conversions",
		"video_views",
	],
	pinterest: ["awareness", "traffic", "video_views"],
	twitter: ["awareness", "traffic", "engagement", "video_views"],
};

export function isAdPlatform(
	value: string | null | undefined,
): value is AdPlatform {
	return AD_PLATFORMS.includes(value as AdPlatform);
}

export function objectivesForPlatform(
	platform: string | null | undefined,
	capabilities: readonly AdPlatformCapabilities[],
): readonly string[] {
	if (!isAdPlatform(platform)) return FALLBACK_OBJECTIVES.meta;
	const live = capabilities.find((entry) => entry.platform === platform);
	return live?.objectives.length
		? live.objectives
		: FALLBACK_OBJECTIVES[platform];
}

/**
 * The live platform registry is authoritative. Account snapshots are only a
 * fallback while the capability request is loading or for older projections.
 */
export function writeCapability(
	account: AdAccountCapabilities | null | undefined,
	operation: AdWriteOperation,
	capabilities: readonly AdPlatformCapabilities[],
): AdCapability | undefined {
	if (!account || !isAdPlatform(account.platform)) return undefined;
	return (
		capabilities.find((entry) => entry.platform === account.platform)
			?.operations[operation] ?? account.capabilities?.[operation]
	);
}

/**
 * Resolve an operation exclusively from the live platform registry. Operations
 * that are absent, still loading, or attached to an unknown platform fail
 * closed instead of trusting an account's potentially stale capability copy.
 */
export function liveWriteCapability(
	platform: string | null | undefined,
	operation: AdWriteOperation,
	capabilities: readonly AdPlatformCapabilities[],
): AdCapability {
	if (!isAdPlatform(platform)) {
		return {
			state: "unsupported",
			reason: "Select a recognized ad platform account.",
		};
	}

	const platformCapabilities = capabilities.find(
		(entry) => entry.platform === platform,
	);
	return (
		platformCapabilities?.operations[operation] ?? {
			state: "unsupported",
			reason: "Live platform capabilities are unavailable. Try again shortly.",
		}
	);
}

export type AudienceRuleParseResult =
	| { value: Record<string, unknown>; error?: never }
	| { value?: never; error: string }
	| { value?: undefined; error?: undefined };

/** Parse the optional website-audience rule without accepting JSON scalars or arrays. */
export function parseAudienceRule(input: string): AudienceRuleParseResult {
	const trimmed = input.trim();
	if (!trimmed) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { error: "Rule must be valid JSON." };
	}

	if (!isRecord(parsed)) {
		return { error: "Rule must be a JSON object." };
	}
	return { value: parsed };
}

export function providerOptionsTemplate(
	platform: string | null | undefined,
	mode: AdProviderOptionsMode,
	objective: string,
): string {
	if (!isAdPlatform(platform) || platform === "meta") return "";

	const campaign = campaignSettingsTemplate(platform, objective);
	const envelope =
		mode === "campaign"
			? { platform, settings: campaign }
			: {
					platform,
					campaign,
					creative: creativeSettingsTemplate(platform, mode),
				};
	return JSON.stringify(envelope, null, 2);
}

function campaignSettingsTemplate(
	platform: Exclude<AdPlatform, "meta">,
	objective: string,
) {
	switch (platform) {
		case "google":
			return {
				contains_eu_political_advertising: "CHOOSE_EXPLICITLY",
				bidding_strategy: "MANUAL_CPC",
				keywords: [{ text: "REPLACE_WITH_KEYWORD", match_type: "PHRASE" }],
				default_cpc_bid_cents: 1,
			};
		case "linkedin":
			return {
				locale: { country: "REPLACE_WITH_COUNTRY_CODE", language: "en" },
				include: [
					{
						facet_urn: "REPLACE_WITH_TARGETING_FACET_URN",
						values: ["REPLACE_WITH_TARGETING_VALUE_URN"],
					},
				],
				associated_entity: "REPLACE_WITH_ORGANIZATION_OR_PERSON_URN",
				political_intent: "CHOOSE_EXPLICITLY",
				...(objective === "video_views" ? { format: "SINGLE_VIDEO" } : {}),
				cost_type: objective === "video_views" ? "CPV" : "CPC",
				unit_cost_cents: 1,
				audience_expansion_enabled: false,
				offsite_delivery_enabled: false,
			};
		case "pinterest":
			return {
				bid_in_micro_currency: 1,
				billable_event: pinterestBillableEvent(objective),
				bid_strategy_type: "AUTOMATIC_BID",
				placement_group: "ALL",
				auto_targeting_enabled: false,
				geo_codes: ["REPLACE_WITH_PROVIDER_GEO_CODE"],
			};
		case "tiktok": {
			const { optimizationGoal, billingEvent } = tiktokGoal(objective);
			return {
				location_ids: ["REPLACE_WITH_LOCATION_ID"],
				optimization_goal: optimizationGoal,
				billing_event: billingEvent,
				budget_mode: "BUDGET_MODE_DAY",
				schedule_type: "SCHEDULE_FROM_NOW",
				schedule_start_time: "REPLACE_WITH_ADVERTISER_TIME_YYYY-MM-DD_HH:mm:ss",
				gender: "GENDER_UNLIMITED",
				bid_type: "BID_TYPE_NO_BID",
			};
		}
		case "twitter":
			return {
				funding_instrument_id: "REPLACE_WITH_FUNDING_INSTRUMENT_ID",
				objective: twitterObjective(objective),
				placements: "ALL_ON_TWITTER",
				bid_strategy: "AUTO",
				allow_worldwide_targeting: false,
			};
	}
}

function creativeSettingsTemplate(
	platform: Exclude<AdPlatform, "meta">,
	mode: Exclude<AdProviderOptionsMode, "campaign">,
) {
	switch (platform) {
		case "google":
			return {
				headlines: [
					"REPLACE_WITH_HEADLINE_1",
					"REPLACE_WITH_HEADLINE_2",
					"REPLACE_WITH_HEADLINE_3",
				],
				descriptions: [
					"REPLACE_WITH_DESCRIPTION_1",
					"REPLACE_WITH_DESCRIPTION_2",
				],
				final_urls: ["REPLACE_WITH_FINAL_URL"],
			};
		case "linkedin":
			return { content_reference: "REPLACE_WITH_EXISTING_CONTENT_URN" };
		case "pinterest":
			return {
				...(mode === "ad" ? { pin_id: "REPLACE_WITH_PIN_ID" } : {}),
				creative_type: "REGULAR",
			};
		case "tiktok":
			return {
				identity_type: "REPLACE_WITH_AUTHORIZED_IDENTITY_TYPE",
				identity_id: "REPLACE_WITH_AUTHORIZED_IDENTITY_ID",
				...(mode === "ad"
					? { tiktok_item_id: "REPLACE_WITH_SPARK_ITEM_OR_USE_VIDEO_ID" }
					: {}),
			};
		case "twitter":
			return mode === "ad" ? { tweet_id: "REPLACE_WITH_TWEET_ID" } : {};
	}
}

function pinterestBillableEvent(objective: string) {
	if (objective === "awareness") return "IMPRESSION";
	if (objective === "video_views") return "VIDEO_V_50_MRC";
	return "CLICKTHROUGH";
}

function tiktokGoal(objective: string) {
	if (objective === "awareness") {
		return { optimizationGoal: "REACH", billingEvent: "CPM" };
	}
	if (objective === "video_views") {
		return { optimizationGoal: "ENGAGED_VIEW", billingEvent: "CPV" };
	}
	return { optimizationGoal: "CLICK", billingEvent: "CPC" };
}

function twitterObjective(objective: string) {
	if (objective === "awareness") return "REACH";
	if (objective === "traffic") return "WEBSITE_CLICKS";
	if (objective === "video_views") return "VIDEO_VIEWS";
	return "ENGAGEMENTS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function placeholderPath(
	value: unknown,
	path = "provider_options",
): string | null {
	if (typeof value === "string") {
		return value.length === 0 ||
			/^(?:REPLACE_WITH_|CHOOSE_EXPLICITLY)/.test(value)
			? path
			: null;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const found = placeholderPath(value[index], `${path}[${index}]`);
			if (found) return found;
		}
		return null;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			const found = placeholderPath(child, `${path}.${key}`);
			if (found) return found;
		}
	}
	return null;
}

export function parseProviderOptions(
	platform: string | null | undefined,
	mode: AdProviderOptionsMode,
	objective: string,
	json: string,
): { value?: Record<string, unknown>; error?: string } {
	if (!isAdPlatform(platform)) {
		return { error: "Select a supported ad account." };
	}
	if (platform === "meta") return {};
	if (!json.trim()) {
		return {
			error: `${platformLabel(platform)} provider options are required.`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { error: "Provider options must be valid JSON." };
	}
	if (!isRecord(parsed))
		return { error: "Provider options must be a JSON object." };
	if (parsed.platform !== platform) {
		return {
			error: `provider_options.platform must be ${platform}.`,
		};
	}
	const placeholder = placeholderPath(parsed);
	if (placeholder) {
		return { error: `Complete the provider value at ${placeholder}.` };
	}

	const settings = mode === "campaign" ? parsed.settings : parsed.campaign;
	if (!isRecord(settings)) {
		return { error: "Provider campaign settings are required." };
	}
	if (mode !== "campaign" && !isRecord(parsed.creative)) {
		return { error: "Provider creative settings are required." };
	}
	const semanticError = validateProviderSemantics(
		platform,
		mode,
		objective,
		settings,
		isRecord(parsed.creative) ? parsed.creative : undefined,
	);
	return semanticError ? { error: semanticError } : { value: parsed };
}

function validateProviderSemantics(
	platform: Exclude<AdPlatform, "meta">,
	mode: AdProviderOptionsMode,
	objective: string,
	settings: Record<string, unknown>,
	creative?: Record<string, unknown>,
): string | undefined {
	switch (platform) {
		case "google": {
			if (
				![
					"CONTAINS_EU_POLITICAL_ADVERTISING",
					"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
				].includes(String(settings.contains_eu_political_advertising))
			) {
				return "Choose Google's EU political-ad declaration explicitly.";
			}
			if (!Array.isArray(settings.keywords) || settings.keywords.length === 0) {
				return "Google Search campaigns require at least one keyword.";
			}
			if (
				settings.bidding_strategy === "MANUAL_CPC" &&
				(typeof settings.default_cpc_bid_cents !== "number" ||
					settings.default_cpc_bid_cents <= 0)
			) {
				return "Google MANUAL_CPC campaigns require a positive default_cpc_bid_cents.";
			}
			if (mode !== "campaign") {
				if (
					!Array.isArray(creative?.headlines) ||
					creative.headlines.length < 3
				) {
					return "Google responsive search ads require at least three headlines.";
				}
				if (
					!Array.isArray(creative?.descriptions) ||
					creative.descriptions.length < 2
				) {
					return "Google responsive search ads require at least two descriptions.";
				}
				if (
					!Array.isArray(creative?.final_urls) ||
					creative.final_urls.length === 0
				) {
					return "Google responsive search ads require at least one final URL.";
				}
			}
			return undefined;
		}
		case "linkedin":
			if (
				!["POLITICAL", "NOT_POLITICAL", "NOT_DECLARED"].includes(
					String(settings.political_intent),
				)
			) {
				return "Choose LinkedIn political intent explicitly.";
			}
			if (!Array.isArray(settings.include) || settings.include.length === 0) {
				return "LinkedIn requires at least one typed targeting include clause.";
			}
			if (objective === "video_views" && settings.format !== "SINGLE_VIDEO") {
				return "LinkedIn video-view campaigns require format SINGLE_VIDEO.";
			}
			if (objective === "leads" && settings.offsite_delivery_enabled === true) {
				return "LinkedIn lead campaigns cannot enable offsite delivery.";
			}
			if (
				mode !== "campaign" &&
				typeof creative?.content_reference !== "string"
			) {
				return "LinkedIn ads require an existing content reference URN.";
			}
			return undefined;
		case "pinterest":
			if (settings.billable_event !== pinterestBillableEvent(objective)) {
				return "Pinterest billable_event must match the selected objective.";
			}
			if (
				!Array.isArray(settings.geo_codes) ||
				settings.geo_codes.length === 0
			) {
				return "Pinterest requires at least one provider geo code in this form.";
			}
			if (
				objective === "video_views" &&
				settings.bid_strategy_type !== "AUTOMATIC_BID"
			) {
				return "Pinterest video-view campaigns require AUTOMATIC_BID.";
			}
			if (mode === "ad" && typeof creative?.pin_id !== "string") {
				return "Pinterest standalone ads require an existing Pin ID.";
			}
			return undefined;
		case "tiktok": {
			const expected = tiktokGoal(objective);
			if (
				settings.optimization_goal !== expected.optimizationGoal ||
				settings.billing_event !== expected.billingEvent
			) {
				return "TikTok optimization_goal and billing_event must match the selected objective.";
			}
			if (
				!Array.isArray(settings.location_ids) ||
				settings.location_ids.length === 0
			) {
				return "TikTok requires at least one provider location ID.";
			}
			if (
				settings.schedule_type === "SCHEDULE_START_END" &&
				typeof settings.schedule_end_time !== "string"
			) {
				return "TikTok SCHEDULE_START_END requires schedule_end_time.";
			}
			if (
				settings.bid_type === "BID_TYPE_CUSTOM" &&
				(typeof settings.bid_price !== "number" || settings.bid_price <= 0)
			) {
				return "TikTok BID_TYPE_CUSTOM requires a positive bid_price.";
			}
			if (mode !== "campaign") {
				if (
					typeof creative?.identity_type !== "string" ||
					typeof creative.identity_id !== "string"
				) {
					return "TikTok requires an authorized identity type and ID.";
				}
				if (mode === "ad") {
					const item = typeof creative.tiktok_item_id === "string";
					const video = typeof creative.video_id === "string";
					if (item === video) {
						return "TikTok standalone ads require exactly one Spark item ID or uploaded video ID.";
					}
				}
			}
			return undefined;
		}
		case "twitter":
			if (settings.objective !== twitterObjective(objective)) {
				return "X Ads objective must match the selected Relay objective.";
			}
			if (settings.allow_worldwide_targeting !== true) {
				return "Explicitly set allow_worldwide_targeting to true to consent to X worldwide delivery.";
			}
			if (
				settings.bid_strategy !== "AUTO" &&
				(typeof settings.bid_amount_local_micro !== "number" ||
					settings.bid_amount_local_micro <= 0)
			) {
				return "X MAX and TARGET bid strategies require bid_amount_local_micro.";
			}
			if (mode === "ad" && typeof creative?.tweet_id !== "string") {
				return "X standalone ads require an existing Tweet ID.";
			}
			return undefined;
	}
}

function platformLabel(platform: AdPlatform): string {
	if (platform === "twitter") return "X Ads";
	if (platform === "google") return "Google Ads";
	return `${platform[0]?.toUpperCase()}${platform.slice(1)} Ads`;
}

export function validateBudget(
	platform: string | null | undefined,
	mode: AdProviderOptionsMode,
	dailyBudgetCents: number | undefined,
	lifetimeBudgetCents: number | undefined,
	startDate: string,
	endDate: string,
): string | undefined {
	if (dailyBudgetCents !== undefined && dailyBudgetCents <= 0) {
		return "Daily budget must be greater than zero.";
	}
	if (lifetimeBudgetCents !== undefined && lifetimeBudgetCents <= 0) {
		return "Lifetime budget must be greater than zero.";
	}
	if (mode === "boost" && dailyBudgetCents === undefined) {
		return "Boosts require a daily budget greater than zero.";
	}
	if (!isAdPlatform(platform) || platform === "meta") return undefined;

	if (["google", "pinterest", "tiktok"].includes(platform)) {
		if (
			(dailyBudgetCents === undefined) ===
			(lifetimeBudgetCents === undefined)
		) {
			return `${platformLabel(platform)} requires exactly one daily or lifetime budget.`;
		}
	}
	if (
		platform === "linkedin" &&
		dailyBudgetCents === undefined &&
		lifetimeBudgetCents === undefined
	) {
		return "LinkedIn Ads requires a daily or lifetime budget.";
	}
	if (platform === "twitter") {
		if (dailyBudgetCents === undefined) return "X Ads requires a daily budget.";
		if (lifetimeBudgetCents !== undefined)
			return "X Ads does not support a lifetime budget.";
	}
	if (lifetimeBudgetCents !== undefined) {
		if (platform === "google" && (!startDate || !endDate)) {
			return "Google lifetime budgets require both start and end dates.";
		}
		if (["linkedin", "pinterest"].includes(platform) && !endDate) {
			return `${platformLabel(platform)} lifetime budgets require an end date.`;
		}
	}
	return undefined;
}

export function validateProviderBudgetAlignment(
	platform: string | null | undefined,
	mode: AdProviderOptionsMode,
	providerOptions: Record<string, unknown> | undefined,
	dailyBudgetCents: number | undefined,
	lifetimeBudgetCents: number | undefined,
): string | undefined {
	if (!isAdPlatform(platform) || platform === "meta" || !providerOptions) {
		return undefined;
	}
	const settings =
		providerOptions[mode === "campaign" ? "settings" : "campaign"];
	if (!isRecord(settings)) return "Provider campaign settings are required.";
	if (platform === "tiktok") {
		if (
			dailyBudgetCents !== undefined &&
			settings.budget_mode !== "BUDGET_MODE_DAY"
		) {
			return "TikTok daily budgets require BUDGET_MODE_DAY.";
		}
		if (
			lifetimeBudgetCents !== undefined &&
			settings.budget_mode !== "BUDGET_MODE_TOTAL"
		) {
			return "TikTok lifetime budgets require BUDGET_MODE_TOTAL.";
		}
	}
	return undefined;
}
