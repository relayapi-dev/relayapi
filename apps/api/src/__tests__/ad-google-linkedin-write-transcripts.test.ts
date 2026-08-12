import { afterEach, describe, expect, it } from "bun:test";
import { API_VERSIONS } from "../config/api-versions";
import { googleAdAdapter } from "../services/ad-platforms/google";
import { linkedinAdAdapter } from "../services/ad-platforms/linkedin";
import type { AdProviderCredentials } from "../services/ad-platforms/types";

interface CapturedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: Record<string, unknown> | null;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function captureRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
): CapturedRequest {
	return {
		url: String(input),
		method: init?.method ?? "GET",
		headers: new Headers(init?.headers),
		body:
			typeof init?.body === "string"
				? (JSON.parse(init.body) as Record<string, unknown>)
				: null,
	};
}

const googleCredentials: AdProviderCredentials = {
	accessToken: "google-token",
	developerToken: "developer-token",
	loginCustomerId: "999-888-7777",
	providerAdAccountId: "123-456-7890",
	grantedScopes: ["https://www.googleapis.com/auth/adwords"],
	metadata: {},
};

const googleCampaignOptions = {
	platform: "google" as const,
	settings: {
		contains_eu_political_advertising:
			"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" as const,
		bidding_strategy: "MANUAL_CPC" as const,
		default_cpc_bid_cents: 125,
		keywords: [{ text: "durable api", match_type: "PHRASE" as const }],
		network_settings: {
			target_google_search: true,
			target_search_network: false,
			target_content_network: false,
			target_partner_search_network: false,
		},
		geo_target_constant_ids: ["2840"],
		language_constant_ids: ["1000"],
	},
};

describe("Google Ads official write transcript", () => {
	it("creates a paused Search campaign hierarchy and RSA with one atomic call per durable phase", async () => {
		const requests: CapturedRequest[] = [];
		globalThis.fetch = (async (input, init) => {
			const request = captureRequest(input, init);
			requests.push(request);
			const operations = request.body?.mutateOperations as
				| Record<string, unknown>[]
				| undefined;
			if (operations?.some((operation) => operation.campaignOperation)) {
				return Response.json({
					mutateOperationResponses: [
						{
							campaignBudgetResult: {
								resourceName: "customers/1234567890/campaignBudgets/10",
							},
						},
						{
							campaignResult: {
								resourceName: "customers/1234567890/campaigns/20",
							},
						},
					],
				});
			}
			if (operations?.some((operation) => operation.adGroupOperation)) {
				return Response.json({
					mutateOperationResponses: [
						{
							adGroupResult: {
								resourceName: "customers/1234567890/adGroups/30",
							},
						},
					],
				});
			}
			return Response.json({
				mutateOperationResponses: [
					{
						adGroupAdResult: {
							resourceName: "customers/1234567890/adGroupAds/30~40",
						},
					},
				],
			});
		}) as typeof fetch;

		const campaignId = await googleAdAdapter.creation.createCampaign(
			"google-token",
			"1234567890",
			{
				name: "Relay launch [relay:google-op]",
				objective: "traffic",
				dailyBudgetCents: 2500,
				currency: "USD",
				providerOptions: googleCampaignOptions,
			},
			googleCredentials,
		);
		const adSetId = await googleAdAdapter.creation.createAdSet(
			"google-token",
			"1234567890",
			{
				campaignId,
				name: "Relay launch [relay:google-op]",
				objective: "traffic",
				currency: "USD",
				mode: "standard",
				dailyBudgetCents: 2500,
				providerOptions: googleCampaignOptions,
			},
			googleCredentials,
		);
		const pair = await googleAdAdapter.creation.createCreativeAndAd?.(
			"google-token",
			"1234567890",
			{
				name: "Relay launch [relay:google-op]",
				providerOptions: {
					platform: "google",
					creative: {
						headlines: [
							"Durable APIs",
							"One Reliable API",
							"Ship Faster Today",
						],
						descriptions: [
							"Publish through one production-safe API.",
							"Build a reliable social publishing workflow.",
						],
						final_urls: ["https://relayapi.dev/ads"],
					},
				},
			},
			{
				adSetId,
				creativeId: "",
				name: "Relay launch [relay:google-op]",
				active: false,
			},
			googleCredentials,
		);

		expect(campaignId).toBe("customers/1234567890/campaigns/20");
		expect(adSetId).toBe("customers/1234567890/adGroups/30");
		expect(pair).toEqual({
			creativeId: "customers/1234567890/ads/40",
			adId: "customers/1234567890/adGroupAds/30~40",
		});
		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.url).toBe(
				`https://googleads.googleapis.com/${API_VERSIONS.google_ads}/customers/1234567890/googleAds:mutate`,
			);
			expect(request.method).toBe("POST");
			expect(request.headers.get("developer-token")).toBe("developer-token");
			expect(request.headers.get("login-customer-id")).toBe("9998887777");
			expect(request.body?.partialFailure).toBe(false);
		}

		const campaignOperations = requests[0]?.body?.mutateOperations as
			| Record<string, unknown>[]
			| undefined;
		const campaignOperation = campaignOperations?.[1]?.campaignOperation as
			| { create: Record<string, unknown> }
			| undefined;
		expect(campaignOperation?.create.status).toBe("PAUSED");
		expect(campaignOperation?.create.containsEuPoliticalAdvertising).toBe(
			"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
		);
		expect(campaignOperation?.create.campaignBudget).toBe(
			"customers/1234567890/campaignBudgets/-1",
		);

		const adGroupOperations = requests[1]?.body?.mutateOperations as
			| Record<string, unknown>[]
			| undefined;
		const adGroupOperation = adGroupOperations?.[0]?.adGroupOperation as
			| { create: Record<string, unknown> }
			| undefined;
		expect(adGroupOperation?.create.status).toBe("PAUSED");
		const rsaOperations = requests[2]?.body?.mutateOperations as
			| Record<string, unknown>[]
			| undefined;
		const adGroupAdOperation = rsaOperations?.[0]?.adGroupAdOperation as
			| { create: Record<string, unknown> }
			| undefined;
		expect(adGroupAdOperation?.create.status).toBe("PAUSED");
		const adObject = adGroupAdOperation?.create.ad as
			| Record<string, unknown>
			| undefined;
		expect(
			(adObject?.urlCustomParameters as unknown[] | undefined)?.[0],
		).toEqual({ key: "relayop", value: "[relay:google-op]" });
	});

	it("uses absolute update/remove operations and rejects immutable RSA names before I/O", async () => {
		const requests: CapturedRequest[] = [];
		globalThis.fetch = (async (input, init) => {
			requests.push(captureRequest(input, init));
			return Response.json({ mutateOperationResponses: [] });
		}) as typeof fetch;

		await googleAdAdapter.pauseAd(
			"google-token",
			"customers/1234567890/adGroupAds/30~40",
			googleCredentials,
		);
		await googleAdAdapter.resumeAd(
			"google-token",
			"customers/1234567890/adGroupAds/30~40",
			googleCredentials,
		);
		await googleAdAdapter.cancelAd(
			"google-token",
			"customers/1234567890/adGroupAds/30~40",
			googleCredentials,
		);
		expect(requests).toHaveLength(3);
		expect(requests.map((request) => request.body?.mutateOperations)).toEqual([
			[
				{
					adGroupAdOperation: {
						update: {
							resourceName: "customers/1234567890/adGroupAds/30~40",
							status: "PAUSED",
						},
						updateMask: "status",
					},
				},
			],
			[
				{
					adGroupAdOperation: {
						update: {
							resourceName: "customers/1234567890/adGroupAds/30~40",
							status: "ENABLED",
						},
						updateMask: "status",
					},
				},
			],
			[
				{
					adGroupAdOperation: {
						remove: "customers/1234567890/adGroupAds/30~40",
					},
				},
			],
		]);
		expect(() =>
			googleAdAdapter.validateMutation?.({
				kind: "update_ad",
				changes: { name: "immutable" },
			}),
		).toThrow("immutable");
		expect(requests).toHaveLength(3);
	});
});

const linkedinCredentials: AdProviderCredentials = {
	accessToken: "linkedin-token",
	providerAdAccountId: "512352200",
	grantedScopes: ["rw_ads"],
	metadata: {},
};

const linkedinCampaignSettings = {
	locale: { country: "US", language: "en" },
	include: [
		{
			facet_urn: "urn:li:adTargetingFacet:locations",
			values: ["urn:li:geo:103644278"],
		},
	],
	exclude: [
		{
			facet_urn: "urn:li:adTargetingFacet:employers",
			values: ["urn:li:company:1000"],
		},
	],
	associated_entity: "urn:li:organization:1234",
	political_intent: "NOT_POLITICAL" as const,
	format: "SINGLE_IMAGE" as const,
	cost_type: "CPC" as const,
	unit_cost_cents: 375,
	audience_expansion_enabled: false,
	offsite_delivery_enabled: false,
};

describe("LinkedIn Marketing API official write transcript", () => {
	it("creates a non-serving campaign group, campaign, and existing-content creative", async () => {
		const requests: CapturedRequest[] = [];
		globalThis.fetch = (async (input, init) => {
			const request = captureRequest(input, init);
			requests.push(request);
			if (request.url.endsWith("/adCampaignGroups")) {
				return new Response(null, {
					status: 201,
					headers: { "x-restli-id": "urn:li:sponsoredCampaignGroup:600" },
				});
			}
			if (request.url.endsWith("/adCampaigns")) {
				return new Response(null, {
					status: 201,
					headers: { "x-restli-id": "urn:li:sponsoredCampaign:700" },
				});
			}
			return new Response(null, {
				status: 201,
				headers: { "x-restli-id": "urn:li:sponsoredCreative:800" },
			});
		}) as typeof fetch;

		const campaignOptions = {
			platform: "linkedin" as const,
			settings: linkedinCampaignSettings,
		};
		const campaignId = await linkedinAdAdapter.creation.createCampaign(
			"linkedin-token",
			"512352200",
			{
				name: "Relay launch [relay:linkedin-op]",
				objective: "traffic",
				dailyBudgetCents: 1800,
				currency: "USD",
				startDate: "2026-09-01T00:00:00.000Z",
				endDate: "2026-09-30T00:00:00.000Z",
				providerOptions: campaignOptions,
			},
			linkedinCredentials,
		);
		const adSetId = await linkedinAdAdapter.creation.createAdSet(
			"linkedin-token",
			"512352200",
			{
				campaignId,
				name: "Relay launch [relay:linkedin-op]",
				objective: "traffic",
				currency: "USD",
				mode: "standard",
				dailyBudgetCents: 1800,
				startDate: "2026-09-01T00:00:00.000Z",
				endDate: "2026-09-30T00:00:00.000Z",
				providerOptions: campaignOptions,
			},
			linkedinCredentials,
		);
		const pair = await linkedinAdAdapter.creation.createCreativeAndAd?.(
			"linkedin-token",
			"512352200",
			{
				name: "Relay launch [relay:linkedin-op]",
				providerOptions: {
					platform: "linkedin",
					creative: {
						content_reference: "urn:li:ugcPost:900",
					},
				},
			},
			{
				adSetId,
				creativeId: "",
				name: "Relay launch [relay:linkedin-op]",
				active: false,
			},
			linkedinCredentials,
		);

		expect(campaignId).toBe("urn:li:sponsoredCampaignGroup:600");
		expect(adSetId).toBe("urn:li:sponsoredCampaign:700");
		expect(pair).toEqual({
			creativeId: "urn:li:sponsoredCreative:800",
			adId: "urn:li:sponsoredCreative:800",
		});
		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.method).toBe("POST");
			expect(request.headers.get("linkedin-version")).toBe(
				API_VERSIONS.linkedin_marketing,
			);
			expect(request.headers.get("x-restli-protocol-version")).toBe("2.0.0");
		}
		expect(requests[0]?.body).toMatchObject({
			account: "urn:li:sponsoredAccount:512352200",
			status: "DRAFT",
			runSchedule: {
				start: Date.parse("2026-09-01T00:00:00.000Z"),
				end: Date.parse("2026-09-30T00:00:00.000Z"),
			},
		});
		expect(requests[1]?.body).toMatchObject({
			campaignGroup: "urn:li:sponsoredCampaignGroup:600",
			associatedEntity: "urn:li:organization:1234",
			objectiveType: "WEBSITE_VISIT",
			politicalIntent: "NOT_POLITICAL",
			status: "DRAFT",
			dailyBudget: { amount: "18.00", currencyCode: "USD" },
			unitCost: { amount: "3.75", currencyCode: "USD" },
			targetingCriteria: {
				include: {
					and: [
						{
							or: {
								"urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"],
							},
						},
					],
				},
			},
		});
		expect(requests[2]?.body).toEqual({
			campaign: "urn:li:sponsoredCampaign:700",
			content: { reference: "urn:li:ugcPost:900" },
			intendedStatus: "DRAFT",
			name: "Relay launch [relay:linkedin-op]",
		});
	});

	it("uses Rest.li partial updates and binds every write to the dedicated ad account", async () => {
		const requests: CapturedRequest[] = [];
		globalThis.fetch = (async (input, init) => {
			const request = captureRequest(input, init);
			requests.push(request);
			if (request.method === "GET") {
				return Response.json({
					elements: [
						{
							id: "urn:li:sponsoredCreative:800",
							campaign: "urn:li:sponsoredCampaign:700",
							name: "Relay launch",
							intendedStatus: "ACTIVE",
						},
					],
					metadata: {},
				});
			}
			return new Response(null, { status: 204 });
		}) as typeof fetch;

		await linkedinAdAdapter.pauseAd(
			"linkedin-token",
			"urn:li:sponsoredCreative:800",
			linkedinCredentials,
		);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe(
			"https://api.linkedin.com/rest/adAccounts/512352200/creatives/urn%3Ali%3AsponsoredCreative%3A800",
		);
		expect(requests[1]?.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE");
		expect(requests[1]?.body).toEqual({
			patch: { $set: { intendedStatus: "PAUSED" } },
		});

		await expect(
			linkedinAdAdapter.creation.createCreativeAndAd?.(
				"linkedin-token",
				"512352200",
				{
					name: "Account-bound [relay:authority]",
					providerOptions: {
						platform: "linkedin",
						creative: { content_reference: "urn:li:ugcPost:900" },
					},
				},
				{
					adSetId: "urn:li:sponsoredCampaign:700",
					creativeId: "",
					name: "Account-bound [relay:authority]",
					active: false,
				},
				{ ...linkedinCredentials, providerAdAccountId: "999" },
			),
		).rejects.toMatchObject({ code: "PROVIDER_ACCOUNT_MISMATCH" });
		expect(requests).toHaveLength(2);
	});
});
