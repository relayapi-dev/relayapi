import { describe, expect, it } from "bun:test";
import {
	getAdPlatformAdapter,
	getSupportedAdPlatforms,
} from "../services/ad-platforms";

describe("advertising platform capability truth", () => {
	it("registers every advertised platform with implemented paid writes", () => {
		expect(getSupportedAdPlatforms()).toEqual([
			"meta",
			"google",
			"tiktok",
			"linkedin",
			"pinterest",
			"twitter",
		]);
		for (const platform of [
			"google",
			"tiktok",
			"linkedin",
			"pinterest",
			"twitter",
		] as const) {
			const adapter = getAdPlatformAdapter(platform);
			expect(adapter).toBeDefined();
			expect(adapter?.capabilities.operations.account_discovery.state).toBe(
				"supported",
			);
			expect(adapter?.capabilities.operations.campaign_create.state).toBe(
				"supported",
			);
			expect(adapter?.capabilities.operations.ad_create.state).toBe(
				"supported",
			);
		}
	});

	it("rejects an unsupported provider operation before provider I/O", async () => {
		const adapter = getAdPlatformAdapter("tiktok");
		if (!adapter) throw new Error("missing TikTok adapter");
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;
		try {
			await expect(
				adapter.getAdMetrics("token", "ad", {
					startDate: "2026-08-01",
					endDate: "2026-08-02",
				}),
			).rejects.toMatchObject({ code: "UNSUPPORTED_FEATURE" });
			expect(calls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("dedicated provider account discovery", () => {
	it("uses Google Ads v25 auth headers and bounded customer discovery", async () => {
		const adapter = getAdPlatformAdapter("google");
		if (!adapter) throw new Error("missing Google adapter");
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = input.toString();
			calls.push({ url, headers: new Headers(init?.headers) });
			if (url.endsWith("/customers:listAccessibleCustomers")) {
				return Response.json({ resourceNames: ["customers/123"] });
			}
			return Response.json({
				results: [
					{
						customer: {
							id: "123",
							descriptiveName: "Search account",
							currencyCode: "GBP",
							timeZone: "Europe/London",
							status: "ENABLED",
							manager: false,
						},
					},
				],
			});
		}) as unknown as typeof fetch;
		try {
			const accounts = await adapter.listAdAccounts("google-token", "", {
				accessToken: "google-token",
				developerToken: "developer-token",
				loginCustomerId: "999-888-7777",
				metadata: {},
			});
			expect(accounts).toEqual([
				expect.objectContaining({
					id: "123",
					name: "Search account",
					currency: "GBP",
				}),
			]);
			expect(calls[0]?.url).toContain("/v25/customers:listAccessibleCustomers");
			expect(calls[0]?.headers.get("authorization")).toBe(
				"Bearer google-token",
			);
			expect(calls[0]?.headers.get("developer-token")).toBe("developer-token");
			expect(calls[0]?.headers.get("login-customer-id")).toBe("9998887777");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("requires TikTok OAuth advertiser_ids before provider I/O", async () => {
		const adapter = getAdPlatformAdapter("tiktok");
		if (!adapter) throw new Error("missing TikTok adapter");
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return Response.json({ code: 0, data: { list: [] } });
		}) as unknown as typeof fetch;
		try {
			await expect(
				adapter.listAdAccounts("business-token", "", {
					accessToken: "business-token",
					metadata: {},
				}),
			).rejects.toMatchObject({ code: "ADS_CONNECTION_SETUP_INCOMPLETE" });
			expect(calls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses LinkedIn monthly and Rest.li headers", async () => {
		const adapter = getAdPlatformAdapter("linkedin");
		if (!adapter) throw new Error("missing LinkedIn adapter");
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = input.toString();
			calls.push({ url, headers: new Headers(init?.headers) });
			if (url.includes("/adAccountUsers")) {
				return Response.json({
					elements: [{ account: "urn:li:sponsoredAccount:42" }],
					paging: { total: 1 },
				});
			}
			return Response.json({
				id: 42,
				name: "LinkedIn account",
				currency: "USD",
				status: "ACTIVE",
			});
		}) as typeof fetch;
		try {
			const accounts = await adapter.listAdAccounts("linkedin-token", "", {
				accessToken: "linkedin-token",
				metadata: {},
			});
			expect(accounts[0]?.id).toBe("42");
			expect(calls[0]?.headers.get("linkedin-version")).toBe("202607");
			expect(calls[0]?.headers.get("x-restli-protocol-version")).toBe("2.0.0");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("imports LinkedIn campaign-group, campaign, and creative hierarchy", async () => {
		const adapter = getAdPlatformAdapter("linkedin");
		if (!adapter) throw new Error("missing LinkedIn adapter");
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = input.toString();
			calls.push({ url, headers: new Headers(init?.headers) });
			if (url.includes("/adCampaignGroups")) {
				return Response.json({
					elements: [{ id: 7, name: "Launch group", status: "ACTIVE" }],
					metadata: {},
				});
			}
			if (url.includes("/adCampaigns")) {
				return Response.json({
					elements: [
						{
							id: 8,
							campaignGroup: "urn:li:sponsoredCampaignGroup:7",
							name: "Lead campaign",
							status: "ACTIVE",
							objectiveType: "LEAD_GENERATION",
							dailyBudget: { amount: "12.50", currencyCode: "GBP" },
						},
					],
					metadata: {},
				});
			}
			return Response.json({
				elements: [
					{
						id: "urn:li:sponsoredCreative:9",
						campaign: "urn:li:sponsoredCampaign:8",
						intendedStatus: "ACTIVE",
						content: { reference: "urn:li:share:10" },
					},
				],
				metadata: {},
			});
		}) as unknown as typeof fetch;
		try {
			const result = await adapter.syncExternalAds(
				"linkedin-token",
				"42",
				undefined,
				{ accessToken: "linkedin-token", metadata: {} },
			);
			expect(result.ads).toEqual([
				expect.objectContaining({
					platformCampaignId: "urn:li:sponsoredCampaignGroup:7",
					platformAdSetId: "urn:li:sponsoredCampaign:8",
					platformAdId: "urn:li:sponsoredCreative:9",
					objective: "leads",
					dailyBudgetCents: 1250,
				}),
			]);
			const creativeCall = calls.find(({ url }) => url.includes("/creatives?"));
			expect(creativeCall?.headers.get("x-restli-method")).toBe("FINDER");
			expect(creativeCall?.headers.get("linkedin-version")).toBe("202607");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("signs X Ads requests with OAuth1 without putting secrets in the URL", async () => {
		const adapter = getAdPlatformAdapter("twitter");
		if (!adapter) throw new Error("missing X adapter");
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		let authorization = "";
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			capturedUrl = input.toString();
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({
				data: [
					{
						id: "x-account",
						name: "X account",
						currency: "USD",
						deleted: false,
					},
				],
				next_cursor: "0",
			});
		}) as typeof fetch;
		try {
			const accounts = await adapter.listAdAccounts("oauth-token", "", {
				accessToken: "oauth-token",
				tokenSecret: "token-secret",
				clientId: "consumer-key",
				clientSecret: "consumer-secret",
				metadata: {},
			});
			expect(accounts[0]?.id).toBe("x-account");
			expect(capturedUrl).toContain("https://ads-api.x.com/12/accounts");
			expect(capturedUrl).not.toContain("consumer-secret");
			expect(capturedUrl).not.toContain("token-secret");
			expect(authorization).toStartWith("OAuth ");
			expect(authorization).toContain("oauth_signature=");
			expect(authorization).not.toContain("consumer-secret");
			expect(authorization).not.toContain("token-secret");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
