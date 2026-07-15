import { describe, expect, it } from "bun:test";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("billing route safety", () => {
	it("retries checkout with stable Stripe idempotency parameters", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/app/src/pages/api/billing/checkout.ts`,
		).text();

		expect(source).not.toContain("expires_at:");
		expect(source).toContain("session.expires_at");
		expect(source).toContain("idempotencyKey: claimed.idempotencyKey");
	});
});
