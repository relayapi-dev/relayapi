import { describe, expect, it } from "bun:test";

describe("ad sync provenance", () => {
	it("marks provider-discovered rows external only on insert", async () => {
		const source = await Bun.file(
			new URL("../services/ad-sync.ts", import.meta.url),
		).text();
		const campaignConflict = source.slice(
			source.indexOf("target: [adCampaigns.adAccountId"),
			source.indexOf("if (!campaign) return null"),
		);
		const adConflict = source.slice(
			source.indexOf("target: [ads.adAccountId"),
			source.indexOf("if (existingAdIds.has"),
		);

		expect(campaignConflict).not.toContain("isExternal:");
		expect(adConflict).not.toContain("isExternal:");
		expect(source.match(/isExternal: true/g)).toHaveLength(2);
	});
});
