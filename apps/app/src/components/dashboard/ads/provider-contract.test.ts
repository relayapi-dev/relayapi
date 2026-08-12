import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type AdPlatformCapabilities,
	liveWriteCapability,
	objectivesForPlatform,
	parseAudienceRule,
	parseProviderOptions,
	providerOptionsTemplate,
	validateBudget,
	validateProviderBudgetAlignment,
	writeCapability,
} from "./provider-contract";

const capabilities: AdPlatformCapabilities[] = [
	{
		platform: "google",
		objectives: ["traffic", "conversions"],
		operations: {
			campaign_create: { state: "supported" },
			ad_create: { state: "supported" },
			boost: { state: "unsupported", reason: "No social-post boost" },
		},
	},
	{
		platform: "pinterest",
		objectives: ["awareness", "traffic", "video_views"],
		operations: {
			campaign_create: { state: "supported" },
			ad_create: { state: "supported" },
			boost: { state: "supported" },
		},
	},
];

const campaignSettings = {
	google: {
		contains_eu_political_advertising:
			"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
		bidding_strategy: "MAXIMIZE_CLICKS",
		keywords: [{ text: "relay api", match_type: "PHRASE" }],
	},
	linkedin: {
		locale: { country: "US", language: "en" },
		include: [
			{
				facet_urn: "urn:li:adTargetingFacet:locations",
				values: ["urn:li:geo:103644278"],
			},
		],
		associated_entity: "urn:li:organization:123",
		political_intent: "NOT_POLITICAL",
		cost_type: "CPC",
		unit_cost_cents: 1,
	},
	pinterest: {
		bid_in_micro_currency: 1,
		billable_event: "CLICKTHROUGH",
		bid_strategy_type: "AUTOMATIC_BID",
		placement_group: "ALL",
		auto_targeting_enabled: false,
		geo_codes: ["US"],
	},
	tiktok: {
		location_ids: ["6252001"],
		optimization_goal: "CLICK",
		billing_event: "CPC",
		budget_mode: "BUDGET_MODE_DAY",
		schedule_type: "SCHEDULE_FROM_NOW",
		schedule_start_time: "2026-08-10 09:00:00",
	},
	twitter: {
		funding_instrument_id: "fi_123",
		objective: "WEBSITE_CLICKS",
		placements: "ALL_ON_TWITTER",
		bid_strategy: "AUTO",
		allow_worldwide_targeting: true,
	},
} as const;

describe("ads dashboard provider request contract", () => {
	test("uses the live registry instead of a stale account capability snapshot", () => {
		const account = {
			platform: "google",
			capabilities: { boost: { state: "supported" as const } },
		};
		expect(writeCapability(account, "boost", capabilities)).toEqual({
			state: "unsupported",
			reason: "No social-post boost",
		});
		expect(objectivesForPlatform("google", capabilities)).toEqual([
			"traffic",
			"conversions",
		]);
	});

	test("fails audience operations closed against the live capability registry", () => {
		const audienceCapabilities: AdPlatformCapabilities[] = [
			{
				platform: "google",
				objectives: [],
				operations: {
					audience_create: {
						state: "requires_approval",
						reason: "Provider approval is required.",
					},
					audience_upload: { state: "unsupported" },
				},
			},
		];

		expect(
			liveWriteCapability("google", "audience_create", audienceCapabilities),
		).toEqual({
			state: "requires_approval",
			reason: "Provider approval is required.",
		});
		expect(
			liveWriteCapability("google", "audience_upload", audienceCapabilities)
				.state,
		).toBe("unsupported");
		expect(
			liveWriteCapability("meta", "audience_create", audienceCapabilities)
				.state,
		).toBe("unsupported");
		expect(
			liveWriteCapability("unknown", "audience_create", audienceCapabilities)
				.state,
		).toBe("unsupported");
	});

	test("accepts only JSON objects for website audience rules", () => {
		expect(parseAudienceRule("")).toEqual({});
		expect(parseAudienceRule('{"url":{"contains":"pricing"}}')).toEqual({
			value: { url: { contains: "pricing" } },
		});
		expect(parseAudienceRule("not json").error).toContain("valid JSON");
		expect(parseAudienceRule("null").error).toContain("JSON object");
		expect(parseAudienceRule("[]").error).toContain("JSON object");
	});

	test("templates require explicit provider decisions instead of silently defaulting them", () => {
		expect(
			parseProviderOptions(
				"google",
				"campaign",
				"traffic",
				providerOptionsTemplate("google", "campaign", "traffic"),
			).error,
		).toContain("Complete the provider value");
		expect(
			parseProviderOptions(
				"twitter",
				"campaign",
				"traffic",
				JSON.stringify({
					platform: "twitter",
					settings: {
						...campaignSettings.twitter,
						allow_worldwide_targeting: false,
					},
				}),
			).error,
		).toContain("Explicitly set allow_worldwide_targeting");
	});

	test("accepts each non-Meta campaign envelope only for its selected platform", () => {
		for (const [platform, settings] of Object.entries(campaignSettings)) {
			const result = parseProviderOptions(
				platform,
				"campaign",
				"traffic",
				JSON.stringify({ platform, settings }),
			);
			expect(result.error).toBeUndefined();
			expect(result.value?.platform).toBe(platform);
		}
		expect(
			parseProviderOptions(
				"google",
				"campaign",
				"traffic",
				JSON.stringify({
					platform: "twitter",
					settings: campaignSettings.twitter,
				}),
			).error,
		).toContain("must be google");
	});

	test("builds valid standalone and boost creative envelopes", () => {
		const standalone = [
			{
				platform: "google",
				creative: {
					headlines: ["One", "Two", "Three"],
					descriptions: ["Description one", "Description two"],
					final_urls: ["https://example.com"],
				},
			},
			{
				platform: "linkedin",
				creative: { content_reference: "urn:li:share:123" },
			},
			{
				platform: "pinterest",
				creative: { pin_id: "123", creative_type: "REGULAR" },
			},
			{
				platform: "tiktok",
				creative: {
					identity_type: "TT_USER",
					identity_id: "identity-123",
					tiktok_item_id: "123",
				},
			},
			{ platform: "twitter", creative: { tweet_id: "123" } },
		] as const;

		for (const value of standalone) {
			const platform = value.platform;
			const result = parseProviderOptions(
				platform,
				"ad",
				"traffic",
				JSON.stringify({
					platform,
					campaign: campaignSettings[platform],
					creative: value.creative,
				}),
			);
			expect(result.error).toBeUndefined();
		}

		expect(
			parseProviderOptions(
				"pinterest",
				"boost",
				"traffic",
				JSON.stringify({
					platform: "pinterest",
					campaign: campaignSettings.pinterest,
					creative: { creative_type: "REGULAR" },
				}),
			).error,
		).toBeUndefined();
		expect(
			parseProviderOptions(
				"twitter",
				"boost",
				"traffic",
				JSON.stringify({
					platform: "twitter",
					campaign: campaignSettings.twitter,
					creative: {},
				}),
			).error,
		).toBeUndefined();
	});

	test("enforces provider budget boundaries before creating a paid object", () => {
		expect(validateBudget("google", "ad", 100, 500, "", "")).toContain(
			"exactly one",
		);
		expect(validateBudget("google", "ad", undefined, 500, "", "")).toContain(
			"both start and end",
		);
		expect(
			validateBudget("twitter", "campaign", undefined, undefined, "", ""),
		).toContain("daily budget");
		expect(
			validateBudget("meta", "boost", undefined, undefined, "", ""),
		).toContain("Boosts require");
		expect(
			validateBudget("pinterest", "ad", 100, undefined, "", ""),
		).toBeUndefined();
		expect(
			validateProviderBudgetAlignment(
				"tiktok",
				"campaign",
				{
					platform: "tiktok",
					settings: {
						...campaignSettings.tiktok,
						budget_mode: "BUDGET_MODE_TOTAL",
					},
				},
				100,
				undefined,
			),
		).toContain("BUDGET_MODE_DAY");
		expect(
			validateProviderBudgetAlignment(
				"tiktok",
				"campaign",
				{
					platform: "tiktok",
					settings: {
						...campaignSettings.tiktok,
						budget_mode: "BUDGET_MODE_TOTAL",
					},
				},
				undefined,
				500,
			),
		).toBeUndefined();
	});

	test("dashboard API mutations stay SDK-backed and expose the live capability route", () => {
		const routeRoot = new URL("../../../pages/api/ads/", import.meta.url);
		const audienceRoute = readFileSync(
			new URL("audiences/index.ts", routeRoot),
			"utf8",
		);
		expect(readFileSync(new URL("platforms.ts", routeRoot), "utf8")).toContain(
			"client.ads.listPlatforms()",
		);
		expect(readFileSync(new URL("index.ts", routeRoot), "utf8")).toContain(
			"client.ads.create(body",
		);
		expect(readFileSync(new URL("boost.ts", routeRoot), "utf8")).toContain(
			"client.ads.boost(body",
		);
		expect(
			readFileSync(new URL("campaigns/index.ts", routeRoot), "utf8"),
		).toContain("client.ads.createCampaign(body");
		expect(audienceRoute).toContain("client.ads.listAudiences({");
		expect(audienceRoute).toContain("ad_account_id is required");
		expect(audienceRoute).toContain("client.ads.createAudience(body");
	});
});
