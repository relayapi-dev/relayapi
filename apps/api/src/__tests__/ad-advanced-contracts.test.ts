import { afterEach, describe, expect, it } from "bun:test";
import {
	ADVANCED_AD_FEATURES,
	AdReportProviderRequest,
} from "../schemas/ads-advanced";
import {
	ADVANCED_AD_PLATFORM_CAPABILITIES,
	effectiveAdvancedAdCapabilities,
} from "../services/ad-advanced-capabilities";
import { getAdvancedAdReportAdapter } from "../services/ad-advanced-reports";
import type { AdProviderCredentials } from "../services/ad-platforms/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("advanced ad capability truth", () => {
	it("returns a complete feature map when an account has an old capability payload", () => {
		const result = effectiveAdvancedAdCapabilities("tiktok", {
			analytics: { state: "unsupported" },
		});
		expect(Object.keys(result).sort()).toEqual(
			[...ADVANCED_AD_FEATURES].sort(),
		);
		expect(result.report_jobs.state).toBe("supported");
		expect(result.forecasts.state).toBe("unsupported");
	});

	it("never lets account JSON elevate a feature without an implementation", () => {
		const result = effectiveAdvancedAdCapabilities("twitter", {
			advanced: {
				lead_inbox: { state: "supported" },
				forecasts: true,
			},
		});
		expect(result.lead_inbox.state).toBe("unsupported");
		expect(result.forecasts.state).toBe("unsupported");
	});

	it("treats a restricted provider scope as exact approval evidence", () => {
		const approved = effectiveAdvancedAdCapabilities("linkedin", null, [
			"r_ads_reporting",
		]);
		expect(approved.report_jobs.state).toBe("supported");

		const missingScope = effectiveAdvancedAdCapabilities("linkedin", {
			advanced: { report_jobs: { state: "supported" } },
		});
		expect(missingScope.report_jobs.state).toBe("requires_approval");
	});

	it("registers report support only where this build has a concrete adapter", () => {
		for (const platform of ["tiktok", "twitter", "linkedin"] as const) {
			expect(getAdvancedAdReportAdapter(platform)?.platform).toBe(platform);
		}
		for (const platform of ["meta", "google", "pinterest"] as const) {
			expect(getAdvancedAdReportAdapter(platform)).toBeUndefined();
			expect(
				ADVANCED_AD_PLATFORM_CAPABILITIES[platform].report_jobs.state,
			).toBe("unsupported");
		}
	});

	it("keeps conversion ingestion closed until a durable delivery worker exists", () => {
		for (const platform of [
			"meta",
			"google",
			"tiktok",
			"linkedin",
			"pinterest",
			"twitter",
		] as const) {
			expect(
				ADVANCED_AD_PLATFORM_CAPABILITIES[platform].conversions.state,
			).toBe("unsupported");
		}
	});

	it("keeps lead inboxes closed until a provider ingestion path exists", () => {
		for (const platform of [
			"meta",
			"google",
			"tiktok",
			"linkedin",
			"pinterest",
			"twitter",
		] as const) {
			expect(ADVANCED_AD_PLATFORM_CAPABILITIES[platform].lead_inbox.state).toBe(
				"unsupported",
			);
		}
	});
});

describe("advanced ad report validation", () => {
	const xRequest = {
		platform: "twitter" as const,
		entity: "LINE_ITEM" as const,
		entity_ids: ["line-item-1"],
		start_time: "2026-01-01T00:00:00Z",
		end_time: "2026-01-02T00:00:00Z",
		granularity: "TOTAL" as const,
		placement: "ALL_ON_TWITTER" as const,
		metric_groups: ["ENGAGEMENT" as const],
	};

	it("enforces X whole-hour, range, entity-count, and metric-group contracts", () => {
		expect(AdReportProviderRequest.safeParse(xRequest).success).toBe(true);
		expect(
			AdReportProviderRequest.safeParse({
				...xRequest,
				start_time: "2026-01-01T00:30:00Z",
			}).success,
		).toBe(false);
		expect(
			AdReportProviderRequest.safeParse({
				...xRequest,
				entity_ids: Array.from({ length: 21 }, (_, index) => String(index)),
			}).success,
		).toBe(false);
		expect(
			AdReportProviderRequest.safeParse({
				...xRequest,
				end_time: "2026-04-02T00:00:00Z",
			}).success,
		).toBe(false);
		expect(
			AdReportProviderRequest.safeParse({
				...xRequest,
				metric_groups: ["MOBILE_CONVERSION", "ENGAGEMENT"],
			}).success,
		).toBe(false);
	});

	it("enforces LinkedIn's current 20-field ceiling and supports current pivots", () => {
		const request = {
			platform: "linkedin" as const,
			pivot: "CONVERSATION_NODE" as const,
			start_date: "2026-01-01",
			end_date: "2026-02-01",
			time_granularity: "YEARLY" as const,
			fields: ["impressions", "pivotValues"],
		};
		expect(AdReportProviderRequest.safeParse(request).success).toBe(true);
		expect(
			AdReportProviderRequest.safeParse({
				...request,
				fields: Array.from({ length: 21 }, (_, index) => `metric${index}`),
			}).success,
		).toBe(false);
	});
});

describe("advanced ad provider report transcripts", () => {
	const credentials: AdProviderCredentials = {
		accessToken: "provider-token",
		metadata: {},
	};

	it("uses TikTok's official v1.3 asynchronous report endpoint and Access-Token", async () => {
		let captured:
			| {
					url: string;
					method: string;
					headers: Headers;
					body: Record<string, unknown>;
			  }
			| undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			captured = {
				url: String(input),
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			};
			return Response.json({
				code: 0,
				message: "OK",
				data: { task_id: "task-1" },
			});
		}) as unknown as typeof fetch;

		const adapter = getAdvancedAdReportAdapter("tiktok");
		if (!adapter) throw new Error("missing TikTok report adapter");
		const result = await adapter.submit(credentials, "700001", {
			platform: "tiktok",
			report_type: "BASIC",
			data_level: "AUCTION_CAMPAIGN",
			dimensions: ["campaign_id"],
			metrics: ["spend"],
			start_date: "2026-01-01",
			end_date: "2026-01-07",
			filters: [],
			output_format: "CSV_DOWNLOAD",
		});

		expect(result).toEqual({
			status: "provider_pending",
			providerJobId: "task-1",
		});
		expect(captured?.url).toBe(
			"https://business-api.tiktok.com/open_api/v1.3/report/task/create/",
		);
		expect(captured?.method).toBe("POST");
		expect(captured?.headers.get("access-token")).toBe("provider-token");
		expect(captured?.body).toMatchObject({
			advertiser_id: "700001",
			service_type: "AUCTION",
			data_level: "AUCTION_CAMPAIGN",
		});
	});

	it("signs X v12 async report creation without putting credentials in the URL", async () => {
		let captured:
			| { url: string; method: string; authorization: string }
			| undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			captured = {
				url: String(input),
				method: init?.method ?? "GET",
				authorization: new Headers(init?.headers).get("authorization") ?? "",
			};
			return Response.json({
				data: { id_str: "x-job-1", status: "PROCESSING" },
			});
		}) as unknown as typeof fetch;

		const adapter = getAdvancedAdReportAdapter("twitter");
		if (!adapter) throw new Error("missing X report adapter");
		const result = await adapter.submit(
			{
				accessToken: "oauth-token",
				tokenSecret: "oauth-token-secret",
				clientId: "consumer-key",
				clientSecret: "consumer-secret",
				metadata: {},
			},
			"18ce54d4x5t",
			{
				platform: "twitter",
				entity: "LINE_ITEM",
				entity_ids: ["el32n"],
				start_time: "2026-03-12T00:00:00Z",
				end_time: "2026-03-20T00:00:00Z",
				granularity: "TOTAL",
				placement: "ALL_ON_TWITTER",
				metric_groups: ["ENGAGEMENT"],
			},
		);

		expect(result).toEqual({
			status: "provider_pending",
			providerJobId: "x-job-1",
		});
		const url = new URL(captured?.url ?? "https://invalid.example");
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://ads-api.x.com/12/stats/jobs/accounts/18ce54d4x5t",
		);
		expect(url.searchParams.get("entity_ids")).toBe("el32n");
		expect(url.searchParams.has("oauth_token")).toBe(false);
		expect(captured?.method).toBe("POST");
		expect(captured?.authorization).toStartWith("OAuth ");
		expect(captured?.authorization).not.toContain("oauth-token-secret");
		expect(captured?.authorization).not.toContain("consumer-secret");
	});

	it("fails LinkedIn approval before I/O, then uses current REST.li headers", async () => {
		const adapter = getAdvancedAdReportAdapter("linkedin");
		if (!adapter) throw new Error("missing LinkedIn report adapter");
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return Response.json({ elements: [] });
		}) as unknown as typeof fetch;
		const request = {
			platform: "linkedin" as const,
			pivot: "CAMPAIGN" as const,
			start_date: "2026-01-01",
			end_date: "2026-01-31",
			time_granularity: "DAILY" as const,
			fields: ["impressions", "clicks"],
		};

		await expect(
			adapter.submit(credentials, "42", request),
		).rejects.toMatchObject({
			code: "ADS_APPROVAL_REQUIRED",
		});
		expect(calls).toBe(0);

		let captured: { url: string; headers: Headers } | undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			captured = { url: String(input), headers: new Headers(init?.headers) };
			return Response.json({ elements: [{ impressions: 10, clicks: 2 }] });
		}) as unknown as typeof fetch;
		const result = await adapter.submit(
			{ ...credentials, grantedScopes: ["r_ads_reporting"] },
			"42",
			request,
		);
		expect(result).toEqual({
			status: "completed",
			inlineRows: [{ impressions: 10, clicks: 2 }],
		});
		const url = new URL(captured?.url ?? "https://invalid.example");
		expect(`${url.origin}${url.pathname}`).toBe(
			"https://api.linkedin.com/rest/adAnalytics",
		);
		expect(url.searchParams.get("q")).toBe("analytics");
		expect(url.searchParams.get("accounts")).toBe(
			"List(urn:li:sponsoredAccount:42)",
		);
		expect(captured?.headers.get("linkedin-version")).toBe("202607");
		expect(captured?.headers.get("x-restli-protocol-version")).toBe("2.0.0");
	});
});
