import { describe, expect, it } from "bun:test";

describe("self-host billing-authority transition compatibility", () => {
	it("keeps hosted transition work gated away from exact self-host mode", async () => {
		const [scheduled, periods] = await Promise.all([
			Bun.file(
				new URL("../../../apps/api/src/scheduled/index.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/services/billing-periods.ts",
					import.meta.url,
				),
			).text(),
		]);
		const hostedTasks = scheduled.slice(
			scheduled.indexOf("...(!isSelfHosted(env)"),
			scheduled.indexOf("account_revocations"),
		);
		expect(hostedTasks).toContain("billing_authority_transitions");
		expect(hostedTasks).toContain("stripe_billing_authorities");
		expect(periods).toContain("transitionExpiredHostedBillingAuthorities");
		expect(periods).toContain('source !== "stripe"');
	});
});
