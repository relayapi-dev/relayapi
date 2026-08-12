import { describe, expect, it } from "bun:test";
import { pinterestAdAdapter } from "../services/ad-platforms/pinterest";
import { tiktokAdAdapter } from "../services/ad-platforms/tiktok";
import { twitterAdAdapter } from "../services/ad-platforms/twitter";
import type { AdProviderCredentials } from "../services/ad-platforms/types";

interface TranscriptCall {
	url: URL;
	method: string;
	headers: Headers;
	body?: unknown;
}

function jsonResponse(value: unknown): Response {
	return Response.json(value, {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function withTranscript<T>(
	responder: (call: TranscriptCall) => Response,
	run: (calls: TranscriptCall[]) => Promise<T>,
): Promise<T> {
	const originalFetch = globalThis.fetch;
	const calls: TranscriptCall[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: TranscriptCall = {
			url: new URL(input.toString()),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body:
				typeof init?.body === "string" && init.body.length > 0
					? JSON.parse(init.body)
					: undefined,
		};
		calls.push(call);
		return responder(call);
	}) as typeof fetch;
	try {
		return await run(calls);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

const pinterestCredentials: AdProviderCredentials = {
	accessToken: "pin-token",
	providerAdAccountId: "123",
	metadata: {},
};

const pinterestCampaignOptions = {
	platform: "pinterest" as const,
	settings: {
		bid_in_micro_currency: 2_000_000,
		billable_event: "CLICKTHROUGH" as const,
		bid_strategy_type: "AUTOMATIC_BID" as const,
		placement_group: "ALL" as const,
		auto_targeting_enabled: false,
		geo_codes: ["GB-ENG"],
	},
};

const pinterestCreateOptions = {
	platform: "pinterest" as const,
	campaign: pinterestCampaignOptions.settings,
	creative: {
		pin_id: "9001",
		creative_type: "REGULAR" as const,
		destination_url: "https://example.com/offer",
	},
};

describe("Pinterest v5 official write transcript", () => {
	it("creates paused campaign/ad-group/ad and promotes an existing Pin atomically", async () => {
		let nextId = 1;
		await withTranscript(
			(_call) =>
				jsonResponse({
					items: [{ data: { id: String(nextId++) }, exceptions: [] }],
				}),
			async (calls) => {
				const campaignId = await pinterestAdAdapter.creation.createCampaign(
					"pin-token",
					"123",
					{
						name: "Launch [relay:op_1]",
						objective: "traffic",
						dailyBudgetCents: 1200,
						providerOptions: pinterestCampaignOptions,
					},
					pinterestCredentials,
				);
				const adGroupId = await pinterestAdAdapter.creation.createAdSet(
					"pin-token",
					"123",
					{
						campaignId,
						name: "Launch [relay:op_1]",
						objective: "traffic",
						mode: "standard",
						dailyBudgetCents: 1200,
						providerOptions: pinterestCampaignOptions,
					},
					pinterestCredentials,
				);
				const result = await pinterestAdAdapter.creation.createCreativeAndAd?.(
					"pin-token",
					"123",
					{
						name: "Launch [relay:op_1]",
						providerOptions: pinterestCreateOptions,
					},
					{
						adSetId: adGroupId,
						creativeId: "",
						name: "Launch [relay:op_1]",
						active: false,
						providerOptions: pinterestCreateOptions,
					},
					pinterestCredentials,
				);

				expect(result).toEqual({ creativeId: "9001", adId: "3" });
				expect(
					calls.map((call) => `${call.method} ${call.url.pathname}`),
				).toEqual([
					"POST /v5/ad_accounts/123/campaigns",
					"POST /v5/ad_accounts/123/ad_groups",
					"POST /v5/ad_accounts/123/ads",
				]);
				expect(calls[0]?.body).toEqual([
					expect.objectContaining({
						objective_type: "CONSIDERATION",
						is_campaign_budget_optimization: false,
						status: "PAUSED",
					}),
				]);
				expect(calls[1]?.body).toEqual([
					expect.objectContaining({
						billable_event: "CLICKTHROUGH",
						budget_in_micro_currency: 12_000_000,
						targeting_spec: { GEO: ["GB-ENG"] },
						status: "PAUSED",
					}),
				]);
				expect(calls[2]?.body).toEqual([
					expect.objectContaining({
						ad_group_id: "2",
						pin_id: "9001",
						status: "PAUSED",
					}),
				]);
			},
		);
	});

	it("uses documented PATCH statuses for update, pause, resume, archive, and boost activation", async () => {
		await withTranscript(
			() => jsonResponse({ items: [{ data: { id: "ok" }, exceptions: [] }] }),
			async (calls) => {
				await pinterestAdAdapter.updateAd(
					"pin-token",
					"ad1",
					{ name: "Renamed" },
					undefined,
					pinterestCredentials,
				);
				await pinterestAdAdapter.pauseAd(
					"pin-token",
					"ad1",
					pinterestCredentials,
				);
				await pinterestAdAdapter.resumeAd(
					"pin-token",
					"ad1",
					pinterestCredentials,
				);
				await pinterestAdAdapter.cancelAd(
					"pin-token",
					"ad1",
					pinterestCredentials,
				);
				await pinterestAdAdapter.pauseCampaign(
					"pin-token",
					"cmp1",
					pinterestCredentials,
				);
				await pinterestAdAdapter.resumeCampaign(
					"pin-token",
					"cmp1",
					pinterestCredentials,
				);
				await pinterestAdAdapter.creation.activateBoost(
					"pin-token",
					"cmp1",
					"ag1",
					undefined,
					pinterestCredentials,
				);

				expect(calls.every((call) => call.method === "PATCH")).toBe(true);
				const statuses = calls.flatMap((call) => {
					const body = call.body as Array<{ status?: string }>;
					return body[0]?.status ? [body[0].status] : [];
				});
				expect(statuses).toEqual([
					"PAUSED",
					"ACTIVE",
					"ARCHIVED",
					"PAUSED",
					"ACTIVE",
					"ACTIVE",
					"ACTIVE",
				]);
			},
		);
	});

	it("rejects a Pinterest batch exception instead of treating HTTP 200 as success", async () => {
		await withTranscript(
			() =>
				jsonResponse({
					items: [
						{ data: null, exceptions: [{ code: 7, message: "invalid" }] },
					],
				}),
			async () => {
				await expect(
					pinterestAdAdapter.pauseAd("pin-token", "ad1", pinterestCredentials),
				).rejects.toMatchObject({ code: "PROVIDER_API_ERROR" });
			},
		);
	});

	it("recovers the distinct Pin and ad IDs after an ambiguous atomic create", async () => {
		await withTranscript(
			() =>
				jsonResponse({
					items: [
						{ id: "ad9", pin_id: "pin9", name: "Launch [relay:op_recover]" },
					],
				}),
			async () => {
				expect(
					await pinterestAdAdapter.creation.findCreatedCreativeAndAd?.(
						"pin-token",
						"123",
						{ phase: "creative", marker: "[relay:op_recover]" },
						pinterestCredentials,
					),
				).toEqual({ creativeId: "pin9", adId: "ad9" });
			},
		);
	});
});

const tiktokCredentials: AdProviderCredentials = {
	accessToken: "tt-token",
	providerAdAccountId: "456",
	metadata: { advertiser_ids: ["456"] },
};

const tiktokCampaignOptions = {
	platform: "tiktok" as const,
	settings: {
		location_ids: ["6252001"],
		optimization_goal: "CLICK" as const,
		billing_event: "CPC" as const,
		promotion_type: "WEBSITE" as const,
		placement_type: "PLACEMENT_TYPE_NORMAL" as const,
		placements: ["PLACEMENT_TIKTOK" as const],
		budget_mode: "BUDGET_MODE_DAY" as const,
		schedule_type: "SCHEDULE_START_END" as const,
		schedule_start_time: "2026-08-10 09:00:00",
		schedule_end_time: "2026-08-17 09:00:00",
		gender: "GENDER_UNLIMITED" as const,
		bid_type: "BID_TYPE_NO_BID" as const,
	},
};

const tiktokCreateOptions = {
	platform: "tiktok" as const,
	campaign: tiktokCampaignOptions.settings,
	creative: {
		identity_type: "TT_USER" as const,
		identity_id: "identity-1",
		tiktok_item_id: "777",
		ad_text: "Official transcript",
		call_to_action: "LEARN_MORE",
		landing_page_url: "https://example.com/tiktok",
	},
};

describe("TikTok Marketing API v1.3 official write transcript", () => {
	it("creates a disabled campaign/ad-group/ad and uses a Spark post for boost", async () => {
		await withTranscript(
			(call) => {
				if (call.url.pathname.endsWith("/campaign/create/")) {
					return jsonResponse({ code: 0, data: { campaign_id: "c1" } });
				}
				if (call.url.pathname.endsWith("/adgroup/create/")) {
					return jsonResponse({ code: 0, data: { adgroup_id: "g1" } });
				}
				return jsonResponse({ code: 0, data: { ad_ids: ["a1"] } });
			},
			async (calls) => {
				const campaignId = await tiktokAdAdapter.creation.createCampaign(
					"tt-token",
					"456",
					{
						name: "Launch [relay:op_2]",
						objective: "traffic",
						dailyBudgetCents: 1500,
						providerOptions: tiktokCampaignOptions,
					},
					tiktokCredentials,
				);
				const adGroupId = await tiktokAdAdapter.creation.createAdSet(
					"tt-token",
					"456",
					{
						campaignId,
						name: "Launch [relay:op_2]",
						objective: "traffic",
						mode: "boost",
						dailyBudgetCents: 1500,
						providerOptions: tiktokCampaignOptions,
					},
					tiktokCredentials,
				);
				const result = await tiktokAdAdapter.creation.createCreativeAndAd?.(
					"tt-token",
					"456",
					{
						name: "Launch [relay:op_2]",
						platformPostId: "888",
						providerOptions: tiktokCreateOptions,
					},
					{
						adSetId: adGroupId,
						creativeId: "",
						name: "Launch [relay:op_2]",
						active: true,
						providerOptions: tiktokCreateOptions,
					},
					tiktokCredentials,
				);

				expect(result).toEqual({ creativeId: "888", adId: "a1" });
				expect(calls.map((call) => call.url.pathname)).toEqual([
					"/open_api/v1.3/campaign/create/",
					"/open_api/v1.3/adgroup/create/",
					"/open_api/v1.3/ad/create/",
				]);
				expect(calls[0]?.body).toEqual(
					expect.objectContaining({
						objective_type: "TRAFFIC",
						operation_status: "DISABLE",
					}),
				);
				expect(calls[1]?.body).toEqual(
					expect.objectContaining({
						location_ids: ["6252001"],
						budget: 15,
						billing_event: "CPC",
						operation_status: "DISABLE",
					}),
				);
				expect(calls[2]?.body).toEqual(
					expect.objectContaining({
						creatives: [
							expect.objectContaining({
								tiktok_item_id: "888",
								identity_type: "TT_USER",
								operation_status: "ENABLE",
							}),
						],
					}),
				);
			},
		);
	});

	it("uses the official absolute status endpoints for pause, resume, delete, and boost activation", async () => {
		await withTranscript(
			() => jsonResponse({ code: 0, data: {} }),
			async (calls) => {
				await tiktokAdAdapter.pauseAd("tt-token", "a1", tiktokCredentials);
				await tiktokAdAdapter.resumeAd("tt-token", "a1", tiktokCredentials);
				await tiktokAdAdapter.cancelAd("tt-token", "a1", tiktokCredentials);
				await tiktokAdAdapter.pauseCampaign(
					"tt-token",
					"c1",
					tiktokCredentials,
				);
				await tiktokAdAdapter.resumeCampaign(
					"tt-token",
					"c1",
					tiktokCredentials,
				);
				await tiktokAdAdapter.creation.activateBoost(
					"tt-token",
					"c1",
					"g1",
					undefined,
					tiktokCredentials,
				);
				expect(calls.map((call) => call.url.pathname)).toEqual([
					"/open_api/v1.3/ad/status/update/",
					"/open_api/v1.3/ad/status/update/",
					"/open_api/v1.3/ad/status/update/",
					"/open_api/v1.3/campaign/status/update/",
					"/open_api/v1.3/campaign/status/update/",
					"/open_api/v1.3/campaign/status/update/",
					"/open_api/v1.3/adgroup/status/update/",
				]);
				expect(
					calls.map(
						(call) =>
							(call.body as { operation_status: string }).operation_status,
					),
				).toEqual([
					"DISABLE",
					"ENABLE",
					"DELETE",
					"DISABLE",
					"ENABLE",
					"ENABLE",
					"ENABLE",
				]);
			},
		);
	});

	it("reads the parent ad group then sends the documented patch ad update", async () => {
		await withTranscript(
			(call) =>
				call.method === "GET"
					? jsonResponse({
							code: 0,
							data: {
								list: [{ ad_id: "a1", adgroup_id: "g1", ad_name: "Old" }],
								page_info: { total_page: 1 },
							},
						})
					: jsonResponse({ code: 0, data: {} }),
			async (calls) => {
				await tiktokAdAdapter.updateAd(
					"tt-token",
					"a1",
					{ name: "Renamed" },
					undefined,
					tiktokCredentials,
				);
				expect(
					calls.map((call) => `${call.method} ${call.url.pathname}`),
				).toEqual([
					"GET /open_api/v1.3/ad/get/",
					"POST /open_api/v1.3/ad/update/",
				]);
				expect(calls[1]?.body).toEqual({
					advertiser_id: "456",
					adgroup_id: "g1",
					patch_update: true,
					creatives: [{ ad_id: "a1", ad_name: "Renamed" }],
				});
			},
		);
	});

	it("rejects non-zero business errors returned inside HTTP 200", async () => {
		await withTranscript(
			() => jsonResponse({ code: 40100, message: "No advertiser access" }),
			async () => {
				await expect(
					tiktokAdAdapter.pauseAd("tt-token", "a1", tiktokCredentials),
				).rejects.toMatchObject({ code: "PROVIDER_API_ERROR" });
			},
		);
	});

	it("recovers distinct TikTok item and ad IDs after an ambiguous create", async () => {
		await withTranscript(
			() =>
				jsonResponse({
					code: 0,
					data: {
						list: [
							{
								ad_id: "ad9",
								tiktok_item_id: "item9",
								ad_name: "Launch [relay:op_recover]",
							},
						],
						page_info: { total_page: 1 },
					},
				}),
			async () => {
				expect(
					await tiktokAdAdapter.creation.findCreatedCreativeAndAd?.(
						"tt-token",
						"456",
						{ phase: "creative", marker: "[relay:op_recover]" },
						tiktokCredentials,
					),
				).toEqual({ creativeId: "item9", adId: "ad9" });
			},
		);
	});
});

const xCredentials: AdProviderCredentials = {
	accessToken: "x-access",
	tokenSecret: "x-token-secret",
	clientId: "x-consumer-key",
	clientSecret: "x-consumer-secret",
	providerAdAccountId: "acc1",
	metadata: {},
};

const xCampaignOptions = {
	platform: "twitter" as const,
	settings: {
		funding_instrument_id: "fund1",
		objective: "ENGAGEMENTS" as const,
		placements: "ALL_ON_TWITTER" as const,
		bid_strategy: "AUTO" as const,
		allow_worldwide_targeting: true as const,
	},
};

const xCreateOptions = {
	platform: "twitter" as const,
	campaign: xCampaignOptions.settings,
	creative: { tweet_id: "987654321" },
};

describe("X Ads API v12 official write transcript", () => {
	it("creates a paused campaign/line item and promoted-Tweet association", async () => {
		await withTranscript(
			(call) => {
				if (call.url.pathname.endsWith("/campaigns")) {
					return jsonResponse({ data: { id: "c1" } });
				}
				if (call.url.pathname.endsWith("/line_items")) {
					return jsonResponse({ data: { id: "l1" } });
				}
				return jsonResponse({
					data: [{ id: "p1", line_item_id: "l1", tweet_id: "987654321" }],
				});
			},
			async (calls) => {
				const campaignId = await twitterAdAdapter.creation.createCampaign(
					"x-access",
					"acc1",
					{
						name: "Launch [relay:op_3]",
						objective: "engagement",
						dailyBudgetCents: 2000,
						providerOptions: xCampaignOptions,
					},
					xCredentials,
				);
				const lineItemId = await twitterAdAdapter.creation.createAdSet(
					"x-access",
					"acc1",
					{
						campaignId,
						name: "Launch [relay:op_3]",
						objective: "engagement",
						mode: "boost",
						dailyBudgetCents: 2000,
						providerOptions: xCampaignOptions,
					},
					xCredentials,
				);
				const result = await twitterAdAdapter.creation.createCreativeAndAd?.(
					"x-access",
					"acc1",
					{
						name: "Launch [relay:op_3]",
						platformPostId: "987654321",
						providerOptions: xCreateOptions,
					},
					{
						adSetId: lineItemId,
						creativeId: "",
						name: "Launch [relay:op_3]",
						active: true,
						providerOptions: xCreateOptions,
					},
					xCredentials,
				);

				expect(result).toEqual({ creativeId: "987654321", adId: "p1" });
				expect(
					calls.map((call) => `${call.method} ${call.url.pathname}`),
				).toEqual([
					"POST /12/accounts/acc1/campaigns",
					"POST /12/accounts/acc1/line_items",
					"POST /12/accounts/acc1/promoted_tweets",
				]);
				expect(calls[0]?.url.searchParams.get("funding_instrument_id")).toBe(
					"fund1",
				);
				expect(calls[0]?.url.searchParams.get("entity_status")).toBe("PAUSED");
				expect(calls[1]?.url.searchParams.get("objective")).toBe("ENGAGEMENTS");
				expect(calls[2]?.url.searchParams.get("tweet_ids")).toBe("987654321");
				expect(
					calls.every((call) =>
						call.headers.get("authorization")?.startsWith("OAuth "),
					),
				).toBe(true);
			},
		);
	});

	it("uses PUT for campaign pause/resume/name, DELETE for removal, and rejects unsupported ad mutation preflight", async () => {
		await withTranscript(
			() => jsonResponse({ data: { id: "ok" } }),
			async (calls) => {
				await twitterAdAdapter.updateCampaign(
					"x-access",
					"c1",
					"l1",
					{ name: "Renamed" },
					xCredentials,
				);
				await twitterAdAdapter.pauseCampaign("x-access", "c1", xCredentials);
				await twitterAdAdapter.resumeCampaign("x-access", "c1", xCredentials);
				await twitterAdAdapter.cancelAd("x-access", "p1", xCredentials);

				expect(calls.map((call) => call.method)).toEqual([
					"PUT",
					"PUT",
					"PUT",
					"DELETE",
				]);
				expect(() =>
					twitterAdAdapter.validateMutation?.({
						kind: "update_ad",
						platformAdId: "p1",
						changes: { status: "paused" },
					}),
				).toThrow("no update or reversible pause/resume endpoint");
			},
		);
	});

	it("recovers the one promoted-Tweet association in the fenced line item", async () => {
		await withTranscript(
			() =>
				jsonResponse({
					data: [{ id: "p9", line_item_id: "l9", tweet_id: "tweet9" }],
				}),
			async (calls) => {
				expect(
					await twitterAdAdapter.creation.findCreatedCreativeAndAd?.(
						"x-access",
						"acc1",
						{
							phase: "creative",
							marker: "[relay:op_recover]",
							platformAdSetId: "l9",
						},
						xCredentials,
					),
				).toEqual({ creativeId: "tweet9", adId: "p9" });
				expect(calls[0]?.url.searchParams.get("line_item_ids")).toBe("l9");
			},
		);
	});
});
