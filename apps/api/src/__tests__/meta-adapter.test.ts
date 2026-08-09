import { describe, expect, it } from "bun:test";
import {
	mapMetaObjectiveToLocal,
	mapMetaSubtypeToLocal,
	metaAdAdapter,
} from "../services/ad-platforms/meta";

describe("meta ad adapter objective normalization", () => {
	it("maps objective-based buying goals to local objectives", () => {
		expect(mapMetaObjectiveToLocal("OUTCOME_TRAFFIC")).toBe("traffic");
		expect(mapMetaObjectiveToLocal("OUTCOME_ENGAGEMENT")).toBe("engagement");
		expect(mapMetaObjectiveToLocal("OUTCOME_SALES")).toBe("conversions");
	});

	it("maps legacy objectives to local objectives", () => {
		expect(mapMetaObjectiveToLocal("LINK_CLICKS")).toBe("traffic");
		expect(mapMetaObjectiveToLocal("LEAD_GENERATION")).toBe("leads");
		expect(mapMetaObjectiveToLocal("VIDEO_VIEWS")).toBe("video_views");
	});

	it("falls back to engagement for unknown objectives", () => {
		expect(mapMetaObjectiveToLocal("SOMETHING_NEW")).toBe("engagement");
		expect(mapMetaObjectiveToLocal()).toBe("engagement");
	});
});

describe("meta ad adapter audience subtype normalization", () => {
	it("maps lookalike and website subtypes", () => {
		expect(mapMetaSubtypeToLocal("LOOKALIKE")).toBe("lookalike");
		expect(mapMetaSubtypeToLocal("WEBSITE")).toBe("website");
	});

	it("collapses everything else to customer_list", () => {
		expect(mapMetaSubtypeToLocal("CUSTOM")).toBe("customer_list");
		expect(mapMetaSubtypeToLocal("IG_BUSINESS")).toBe("customer_list");
		expect(mapMetaSubtypeToLocal("FB_EVENT")).toBe("customer_list");
		expect(mapMetaSubtypeToLocal()).toBe("customer_list");
	});
});

describe("meta ad adapter listAudiences", () => {
	it("maps Graph custom audiences to PlatformAudience shape", async () => {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL) => {
			calls.push(url.toString());
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "1",
							name: "Customers",
							subtype: "CUSTOM",
							description: "uploaded list",
							approximate_count_lower_bound: 1000,
							approximate_count_upper_bound: 1500,
							delivery_status: { code: 200, description: "Normal" },
							operation_status: { code: 200, description: "Ready" },
						},
						{
							id: "2",
							name: "Lookalike 1%",
							subtype: "LOOKALIKE",
							approximate_count_lower_bound: 500,
							operation_status: { code: 200, description: "Ready" },
						},
						{
							id: "3",
							name: "Site visitors",
							subtype: "WEBSITE",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;

		try {
			const result = await metaAdAdapter.listAudiences("tok", "act_123");

			// Hits the ad account's customaudiences edge.
			expect(calls[0]).toContain("/act_123/customaudiences");

			expect(result).toHaveLength(3);

			// Prefers the upper bound for size, delivery_status description for status.
			expect(result[0]).toMatchObject({
				id: "1",
				name: "Customers",
				type: "customer_list",
				description: "uploaded list",
				size: 1500,
				status: "Normal",
			});

			// Falls back to the lower bound and operation_status description.
			expect(result[1]).toMatchObject({
				id: "2",
				type: "lookalike",
				size: 500,
				status: "Ready",
			});

			// Missing fields degrade to nulls.
			expect(result[2]).toMatchObject({
				id: "3",
				type: "website",
				description: null,
				size: null,
				status: null,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("meta paid-object crash recovery", () => {
	it("retains default geography for partial targeting", async () => {
		const originalFetch = globalThis.fetch;
		let requestBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ id: "adset_1" });
		}) as typeof fetch;

		try {
			await metaAdAdapter.creation.createAdSet("tok", "act_123", {
				campaignId: "campaign_1",
				name: "Launch",
				mode: "standard",
				targeting: {
					ageMin: 25,
					interests: [{ id: "interest_1", name: "Software" }],
				},
			});
			expect(requestBody?.targeting).toEqual({
				age_min: 25,
				flexible_spec: [
					{ interests: [{ id: "interest_1", name: "Software" }] },
				],
				geo_locations: { countries: ["US"] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("forwards explicit standard-campaign targeting instead of replacing it with US", async () => {
		const originalFetch = globalThis.fetch;
		const requestBodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			requestBodies.push(
				JSON.parse(String(init?.body)) as Record<string, unknown>,
			);
			return Response.json({ id: "adset_1" });
		}) as typeof fetch;

		try {
			await metaAdAdapter.creation.createAdSet("tok", "act_123", {
				campaignId: "campaign_1",
				name: "Launch",
				mode: "standard",
				targeting: {
					ageMin: 25,
					locations: [{ countries: ["GB", "DE"] }],
				},
			});
			expect(requestBodies[0]?.targeting).toEqual({
				age_min: 25,
				geo_locations: { countries: ["GB", "DE"] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("projects city radius, locale, placement, and provider-specific targeting", () => {
		const canonicalizeTargeting = metaAdAdapter.canonicalizeTargeting;
		if (!canonicalizeTargeting) {
			throw new Error("Meta adapter must expose targeting canonicalization");
		}
		expect(
			canonicalizeTargeting({
				locations: [
					{ countries: ["GB"], cities: ["2420605"], radiusMiles: 10 },
				],
				languages: ["24", "24"],
				placements: ["instagram"],
				platformSpecific: {
					device_platforms: ["mobile"],
					publisher_platforms: ["facebook"],
				},
			}),
		).toEqual({
			geo_locations: {
				countries: ["GB"],
				cities: [{ key: "2420605", radius: 10, distance_unit: "mile" }],
			},
			locales: [24],
			publisher_platforms: ["instagram"],
			device_platforms: ["mobile"],
		});
		expect(() => canonicalizeTargeting({ locations: [{}] })).toThrow(
			"Meta targeting locations require at least one country or city key",
		);
		try {
			canonicalizeTargeting({ languages: ["en"] });
			throw new Error("expected targeting rejection");
		} catch (error) {
			expect(error).toMatchObject({ code: "INVALID_TARGETING" });
		}
	});

	it("requires a city when radius targeting is requested", () => {
		const canonicalizeTargeting = metaAdAdapter.canonicalizeTargeting;
		if (!canonicalizeTargeting) throw new Error("missing canonicalizer");
		expect(() =>
			canonicalizeTargeting({
				locations: [{ countries: ["GB"], radiusMiles: 5 }],
			}),
		).toThrow("radius_miles requires at least one city key");
	});

	it("lets normalized all-gender targeting override raw provider fields", () => {
		const canonicalizeTargeting = metaAdAdapter.canonicalizeTargeting;
		if (!canonicalizeTargeting) throw new Error("missing canonicalizer");
		// No creation default here: canonicalization is the pure projection of
		// what the caller asked for, and is verified as a subset of the remote
		// spec, so it must not assert an unrequested geography.
		expect(
			canonicalizeTargeting({
				genders: ["all"],
				platformSpecific: { genders: [1] },
			}),
		).toEqual({});
	});

	it("rejects locale ids that cannot round-trip safely", () => {
		const canonicalizeTargeting = metaAdAdapter.canonicalizeTargeting;
		if (!canonicalizeTargeting) throw new Error("missing canonicalizer");
		expect(() =>
			canonicalizeTargeting({ languages: ["9007199254740992"] }),
		).toThrow("positive safe-integer");
	});

	it("finds a correlated object with bounded cursor pagination", async () => {
		const originalFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL) => {
			calls.push(url.toString());
			const page = calls.length;
			return Response.json({
				data:
					page === 3
						? [{ id: "campaign_3", name: "Launch [relay:adop_1]" }]
						: [{ id: `campaign_${page}`, name: "Unrelated" }],
				paging:
					page < 3
						? { next: "present", cursors: { after: `cursor_${page}` } }
						: undefined,
			});
		}) as typeof fetch;

		try {
			const id = await metaAdAdapter.creation.findCreatedObject(
				"tok",
				"act_123",
				{
					phase: "campaign",
					marker: "[relay:adop_1]",
				},
			);
			expect(id).toBe("campaign_3");
			expect(calls).toHaveLength(3);
			expect(calls[1]).toContain("after=cursor_1");
			expect(calls[2]).toContain("after=cursor_2");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("stops correlation lookup after three full pages", async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = Object.assign(
			async () => {
				calls += 1;
				return Response.json({
					data: [{ id: `creative_${calls}`, name: "Unrelated" }],
					paging: { next: "present", cursors: { after: `cursor_${calls}` } },
				});
			},
			{ preconnect: originalFetch.preconnect },
		);

		try {
			const id = await metaAdAdapter.creation.findCreatedObject(
				"tok",
				"act_123",
				{
					phase: "creative",
					marker: "[relay:adop_missing]",
				},
			);
			expect(id).toBeNull();
			expect(calls).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps the operation marker on boost creatives", async () => {
		const originalFetch = globalThis.fetch;
		let body: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return Response.json({ id: "creative_1" });
		}) as typeof fetch;

		try {
			await metaAdAdapter.creation.createCreative("tok", "act_123", {
				name: "Boosted Post [relay:adop_1]",
				platformPostId: "page_1_post_1",
			});
			expect(body).toMatchObject({
				name: "Boosted Post [relay:adop_1] - Creative",
				object_story_id: "page_1_post_1",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("checks boost activation with exact read-only requests", async () => {
		const originalFetch = globalThis.fetch;
		const calls: { url: string; method?: string }[] = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push({ url: url.toString(), method: init?.method });
			return Response.json({
				status: url.toString().includes("campaign_1") ? "ACTIVE" : "PAUSED",
			});
		}) as typeof fetch;

		try {
			const active = await metaAdAdapter.creation.isBoostActivated(
				"tok",
				"campaign_1",
				"adset_1",
			);
			expect(active).toBe(false);
			expect(calls).toHaveLength(2);
			expect(calls.every((call) => call.method === undefined)).toBe(true);
			expect(calls.every((call) => call.url.includes("fields=status"))).toBe(
				true,
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("meta mutation acknowledgements", () => {
	it("preserves the ad set's geography on partial targeting updates", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{
			url: string;
			method?: string;
			body?: Record<string, unknown>;
		}> = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push({
				url: url.toString(),
				method: init?.method,
				body: init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined,
			});
			if (calls.length === 1) return Response.json({ adset_id: "adset_1" });
			if (calls.length === 2) {
				return Response.json({
					targeting: { geo_locations: { countries: ["IT"] }, age_min: 18 },
				});
			}
			return Response.json({ success: true });
		}) as typeof fetch;

		try {
			await metaAdAdapter.updateAd("tok", "ad_1", {
				targeting: { ageMin: 30 },
			});
			// Meta replaces the whole spec, so the write must carry Italy forward
			// rather than relocating the ad set to the default US geography.
			expect(calls[2]?.body?.targeting).toEqual({
				age_min: 30,
				geo_locations: { countries: ["IT"] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("falls back to the default geography when the ad set has none", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push({
				url: url.toString(),
				body: init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined,
			});
			if (calls.length === 1) return Response.json({ adset_id: "adset_1" });
			if (calls.length === 2) return Response.json({ targeting: {} });
			return Response.json({ success: true });
		}) as typeof fetch;

		try {
			await metaAdAdapter.updateAd("tok", "ad_1", {
				targeting: { ageMin: 30 },
			});
			expect(calls[2]?.body?.targeting).toEqual({
				age_min: 30,
				geo_locations: { countries: ["US"] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("skips the ad-set targeting read when the caller supplies geography", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			calls.push({
				url: url.toString(),
				body: init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined,
			});
			return calls.length === 1
				? Response.json({ adset_id: "adset_1" })
				: Response.json({ success: true });
		}) as typeof fetch;

		try {
			await metaAdAdapter.updateAd("tok", "ad_1", {
				targeting: { ageMin: 30, locations: [{ countries: ["GB"] }] },
			});
			expect(calls).toHaveLength(2);
			expect(calls[1]?.body?.targeting).toEqual({
				age_min: 30,
				geo_locations: { countries: ["GB"] },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("revalidates after the ad-set lookup and blocks a stale-token budget write", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; method?: string }> = [];
		globalThis.fetch = Object.assign(
			async (url: string | URL, init?: RequestInit) => {
				calls.push({ url: url.toString(), method: init?.method });
				return Response.json({ adset_id: "adset_1" });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		try {
			await expect(
				metaAdAdapter.updateAd(
					"stale-token",
					"ad_1",
					{ dailyBudgetCents: 500 },
					async () => {
						throw new Error("provider authority ended during lookup");
					},
				),
			).rejects.toThrow("provider authority ended during lookup");
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ method: undefined });
			expect(calls[0]?.url).toContain("/ad_1?fields=adset_id");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses the freshly revalidated token for the ad-set budget write", async () => {
		const originalFetch = globalThis.fetch;
		const calls: Array<{ url: string; method?: string }> = [];
		let refreshes = 0;
		globalThis.fetch = Object.assign(
			async (url: string | URL, init?: RequestInit) => {
				calls.push({ url: url.toString(), method: init?.method });
				return calls.length === 1
					? Response.json({ adset_id: "adset_1" })
					: Response.json({ success: true });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		try {
			await metaAdAdapter.updateAd(
				"stale-token",
				"ad_1",
				{ dailyBudgetCents: 500 },
				async () => {
					refreshes += 1;
					return "rotated-token";
				},
			);
			expect(refreshes).toBe(1);
			expect(calls).toHaveLength(2);
			expect(calls[0]?.url).toContain("access_token=stale-token");
			expect(calls[1]).toMatchObject({ method: "POST" });
			expect(calls[1]?.url).toContain("/adset_1?access_token=rotated-token");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("accepts an explicit true acknowledgement", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () => Response.json({ success: true }),
			{ preconnect: originalFetch.preconnect },
		);

		try {
			await expect(
				metaAdAdapter.pauseAd("tok", "ad_1"),
			).resolves.toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects an explicit false acknowledgement from a successful HTTP response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () => Response.json({ success: false }),
			{ preconnect: originalFetch.preconnect },
		);

		try {
			const attempt = metaAdAdapter.resumeCampaign("tok", "campaign_1");
			await expect(attempt).rejects.toMatchObject({
				name: "AdPlatformError",
				code: "META_MUTATION_NOT_ACKNOWLEDGED",
				platformError: { success: false },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects a 200 response that omits the mutation acknowledgement", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(async () => Response.json({}), {
			preconnect: originalFetch.preconnect,
		});

		try {
			const attempt = metaAdAdapter.deleteAudience("tok", "audience_1");
			await expect(attempt).rejects.toMatchObject({
				name: "AdPlatformError",
				code: "META_MUTATION_NOT_ACKNOWLEDGED",
				platformError: {},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
