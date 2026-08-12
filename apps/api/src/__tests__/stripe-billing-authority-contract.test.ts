import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("Stripe billing-authority repair contract", () => {
	it("keeps provider I/O outside transactions and fences every projection", () => {
		const source = readFileSync(
			new URL("../services/stripe-billing-authority.ts", import.meta.url),
			"utf8",
		);
		const canonicalRead = source.indexOf("resolveCanonicalStripeSubscription(");
		const firstProjection = source.indexOf("db.transaction", canonicalRead);

		expect(source).toContain("claimStripeOrganizationFence");
		expect(source).toContain("releaseStripeOrganizationFence");
		expect(canonicalRead).toBeGreaterThan(-1);
		expect(firstProjection).toBeGreaterThan(canonicalRead);
		expect(
			source.match(/assertStripeOrganizationFence\(tx, fence\)/g)?.length,
		).toBe(2);
		expect(source).toContain("resumeStripeBillingPeriod");
		expect(source).not.toContain("openBillingPeriod");
	});

	it("runs a fair, bounded exact-authority backstop only in hosted mode", () => {
		const source = readFileSync(
			new URL("../services/stripe-billing-authority.ts", import.meta.url),
			"utf8",
		);

		expect(source).toContain("if (isSelfHosted(env)) return 0");
		expect(source).toContain(
			"Math.min(Math.max(Math.trunc(batchSize), 1), 50)",
		);
		expect(source).toContain("NOT EXISTS");
		expect(source).toContain(
			"current_bucket.billing_period_id = current_period.id",
		);
		expect(source).toContain("stripeOrganizationLeases.updatedAt");
		expect(source).toContain(".limit(limit)");
		expect(source).toContain("const sweepInvocationId = crypto.randomUUID()");
		expect(source).toContain(
			`billing-authority-sweep:\${sweepInvocationId}:\${candidate.organizationId}`,
		);
		// A missed renewal webhook leaves the local period stale. Candidate
		// discovery must still ask Stripe for the new canonical cycle.
		expect(source).not.toContain(
			"lte(organizationSubscriptions.currentPeriodStart, now)",
		);
	});
});
