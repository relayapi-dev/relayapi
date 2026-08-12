import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("dunning durability contract", () => {
	it("claims and fences effects, reconciles cancellation, and reuses stable keys", () => {
		const source = readFileSync(
			new URL("../services/dunning.ts", import.meta.url),
			"utf8",
		);
		const billingPeriodsSource = readFileSync(
			new URL("../services/billing-periods.ts", import.meta.url),
			"utf8",
		);

		expect(source).toContain('status: "processing"');
		expect(source).toContain("leaseToken: sql");
		expect(source).toContain("claimFence(row)");
		expect(source).toContain("deliveryIdempotencyKey");
		expect(source).toContain("idempotencyKey: row.deactivationOperationId");
		expect(source).toContain("stripe.subscriptions.retrieve");
		expect(source).toContain("parkAmbiguousDeactivation");
		expect(source).toContain('? ("manual_review" as const)');
		expect(source).toContain("claimStripeOrganizationFence");
		expect(source).toContain("assertStripeOrganizationFence");
		expect(source).toContain("releaseStripeOrganizationFence");
		expect(source).toContain("stripe.invoices.retrieve");
		expect(source).toContain("recoverStripeBillingAuthority");
		expect(billingPeriodsSource).toContain(
			"export async function recoverStripeBillingAuthority",
		);
		expect(billingPeriodsSource).toContain('kind: "auth_cache.refresh"');
		expect(source).toContain('action: "skipped_superseded"');
		expect(source).toContain(
			'policy: "ambiguous_stripe_cancellation_30_day_horizon_v1"',
		);
		expect(source).toContain(
			'deactivationStatus: horizonExhausted ? "manual_review" : "unknown"',
		);
		expect(source).not.toContain("!sentEvents.has");
	});
});
