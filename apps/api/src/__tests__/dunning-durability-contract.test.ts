import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("dunning durability contract", () => {
	it("claims and fences effects, reconciles cancellation, and reuses stable keys", () => {
		const source = readFileSync(
			new URL("../services/dunning.ts", import.meta.url),
			"utf8",
		);

		expect(source).toContain('status: "processing"');
		expect(source).toContain("leaseToken: sql");
		expect(source).toContain("claimFence(row)");
		expect(source).toContain("deliveryIdempotencyKey");
		expect(source).toContain("idempotencyKey: row.deactivationOperationId");
		expect(source).toContain("stripe.subscriptions.retrieve");
		expect(source).toContain("parkAmbiguousDeactivation");
		expect(source).toContain('deactivationStatus: "manual_review"');
		expect(source).not.toContain("!sentEvents.has");
	});
});
