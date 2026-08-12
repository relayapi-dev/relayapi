import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host Stripe event attribution compatibility", () => {
	it("ships nullable durable tenant attribution without requiring Stripe", async () => {
		const [schema, webhook, retention, invariant] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/routes/stripe-webhooks.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/financial-retention.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/db/scripts/render-stripe-event-attribution-invariant-sql.ts`,
			).text(),
		]);
		const stripeSchema = schema.slice(
			schema.indexOf("export const stripeEvents = pgTable("),
			schema.indexOf("export const stripeOrganizationLeases = pgTable("),
		);

		expect(stripeSchema).toContain('organizationId: text("organization_id")');
		expect(stripeSchema).not.toContain(".references(");
		expect(invariant).toContain("OLD.");
		expect(invariant).toContain("contract.columnName");
		expect(invariant).toContain("IS DISTINCT FROM OLD");
		expect(webhook).toContain("persistStripeEventOrganizationAttribution");
		expect(retention).toContain(
			"eq(stripeEvents.organizationId, organizationId)",
		);
		expect(retention).not.toContain("isSelfHosted");
	});
});
