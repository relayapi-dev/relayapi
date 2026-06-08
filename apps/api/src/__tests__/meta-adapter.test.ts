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
