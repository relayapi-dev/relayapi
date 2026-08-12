import { expect, test } from "bun:test";
import {
	renderStripeEventAttributionInvariantSql,
	STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT,
} from "./render-stripe-event-attribution-invariant-sql";

test("renders set-once Stripe event organization attribution", () => {
	const sql = renderStripeEventAttributionInvariantSql();
	const contract = STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT;

	expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
	expect(sql).toContain(
		'OLD."organization_id" IS NOT NULL\n\t\tAND NEW."organization_id" IS DISTINCT FROM OLD."organization_id"',
	);
	expect(sql).toContain(
		"Stripe event organization attribution is immutable once set",
	);
	expect(sql).not.toContain("REFERENCES");
});
