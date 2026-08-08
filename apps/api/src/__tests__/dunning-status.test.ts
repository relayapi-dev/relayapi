import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import {
	canonicalDunningDecision,
	DUNNING_DEACTIVATION_RECOVERY_MS,
	dunningDeactivationNeedsManualReview,
	recoveredSubscriptionProjection,
} from "../services/dunning";

describe("canonical dunning deactivation guard", () => {
	it("never cancels a subscription that canonically recovered", () => {
		expect(canonicalDunningDecision("active")).toBe("recovered");
		expect(canonicalDunningDecision("trialing")).toBe("recovered");
	});

	it("cancels only canonical delinquent states", () => {
		expect(canonicalDunningDecision("past_due")).toBe("cancel");
		expect(canonicalDunningDecision("unpaid")).toBe("cancel");
		expect(canonicalDunningDecision("paused")).toBe("manual_review");
		expect(canonicalDunningDecision("incomplete")).toBe("manual_review");
	});

	it("recognizes subscriptions that are already inactive", () => {
		expect(canonicalDunningDecision("canceled")).toBe("already_inactive");
		expect(canonicalDunningDecision("incomplete_expired")).toBe(
			"already_inactive",
		);
	});

	it("heals only a recovered server-tagged base subscription", () => {
		const recovered = {
			id: "sub_base",
			status: "active",
			customer: "cus_1",
			metadata: {
				relayapi_managed_by: "relayapi",
				relayapi_role: "base",
			},
			items: {
				data: [
					{
						current_period_start: 1_784_502_000,
						current_period_end: 1_787_180_400,
					},
				],
			},
			trial_end: null,
			cancel_at: null,
			cancel_at_period_end: false,
		} as unknown as Stripe.Subscription;
		expect(recoveredSubscriptionProjection(recovered)).toMatchObject({
			status: "active",
			delinquentAt: null,
			graceEndsAt: null,
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_base",
		});
		expect(
			recoveredSubscriptionProjection({
				...recovered,
				metadata: {
					relayapi_managed_by: "relayapi",
					relayapi_role: "phone_addon",
				},
			} as Stripe.Subscription),
		).toBeNull();
		expect(
			recoveredSubscriptionProjection({
				...recovered,
				status: "past_due",
			} as Stripe.Subscription),
		).toBeNull();
	});

	it("parks ambiguous cancellation outcomes for the full 30-day horizon", () => {
		const createdAt = new Date("2026-06-01T00:00:00.000Z");
		expect(
			dunningDeactivationNeedsManualReview(
				createdAt,
				new Date(createdAt.getTime() + DUNNING_DEACTIVATION_RECOVERY_MS - 1),
			),
		).toBe(false);
		expect(
			dunningDeactivationNeedsManualReview(
				createdAt,
				new Date(createdAt.getTime() + DUNNING_DEACTIVATION_RECOVERY_MS),
			),
		).toBe(true);
	});
});
