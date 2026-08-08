import { describe, expect, it } from "bun:test";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("billing route safety", () => {
	it("keeps every dashboard billing route as an SDK-only proxy", async () => {
		const methods = {
			checkout: "checkout",
			portal: "portal",
			status: "status",
			sync: "sync",
		} as const;
		for (const [route, method] of Object.entries(methods)) {
			const source = await Bun.file(
				`${repoRoot}apps/app/src/pages/api/billing/${route}.ts`,
			).text();
			expect(source).toContain(`client.billing.${method}(`);
			expect(source).not.toContain("cloudflare:workers");
			expect(source).not.toContain("@relayapi/db");
			expect(source).not.toContain('from "stripe"');
			expect(source).not.toContain("STRIPE_");
		}
	});

	it("does not ship Stripe ownership in the dashboard package or env types", async () => {
		const [packageJson, envTypes] = await Promise.all([
			Bun.file(`${repoRoot}apps/app/package.json`).text(),
			Bun.file(`${repoRoot}apps/app/src/env.d.ts`).text(),
		]);
		expect(packageJson).not.toContain('"stripe"');
		expect(envTypes).not.toContain("STRIPE_SECRET_KEY");
		expect(envTypes).not.toContain("STRIPE_PRO_PRICE_ID");
	});
});
