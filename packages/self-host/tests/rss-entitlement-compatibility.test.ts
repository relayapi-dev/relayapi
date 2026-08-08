import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host RSS entitlement compatibility", () => {
	it("keeps community RSS generation plan-independent while hosted claims fail closed", async () => {
		const [generator, wrangler] = await Promise.all([
			Bun.file(
				`${repositoryRoot}apps/api/src/services/rss-generator.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		expect(wrangler).toContain('DEPLOYMENT_MODE: "self_hosted"');
		expect(generator).toContain("const selfHosted = isSelfHosted(env)");
		expect(generator).toContain(
			"const rules = await claimDueRules(db, new Date(), selfHosted)",
		);
		expect(generator).toContain("if (!selfHosted)");
		expect(generator).toContain("hostedAutoPostEligibility(now)");
		expect(generator).toContain("lockOrganizationSubscription(\n\t\t\t\t\ttx,");
	});
});
