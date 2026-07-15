import { describe, expect, it } from "bun:test";
import {
	API_KEY_CACHE_TTL_SECONDS,
	apiKeyCacheTtl,
	getBillingPolicy,
} from "@relayapi/config";

const now = new Date("2026-07-12T12:00:00.000Z");

describe("shared billing policy", () => {
	it("grants active entitlement while separating Stripe billability", () => {
		expect(getBillingPolicy({ status: "active" }, now)).toMatchObject({
			entitlement: "pro",
			billable: false,
		});
		expect(
			getBillingPolicy(
				{ status: "active", stripeSubscriptionId: "sub_123" },
				now,
			),
		).toMatchObject({ entitlement: "pro", billable: true });
	});

	it("requires authoritative, unexpired Stripe proof for trials", () => {
		expect(getBillingPolicy({ status: "trialing" }, now).entitlement).toBe(
			"free",
		);
		expect(
			getBillingPolicy(
				{
					status: "trialing",
					stripeSubscriptionId: "sub_trial",
					trialEndsAt: "2026-07-20T00:00:00.000Z",
				},
				now,
			),
		).toMatchObject({
			entitlement: "pro",
			billable: false,
			reason: "authoritative_trial",
		});
	});

	it("returns a usage period separately from entitlement", () => {
		const decision = getBillingPolicy(
			{
				status: "active",
				stripeSubscriptionId: "sub_123",
				currentPeriodStart: "2026-07-01T00:00:00.000Z",
				currentPeriodEnd: "2026-08-01T00:00:00.000Z",
			},
			now,
		);
		expect(decision.usagePeriod?.start.toISOString()).toBe(
			"2026-07-01T00:00:00.000Z",
		);
	});

	it("centralizes the auth-cache backstop at ten minutes", () => {
		expect(API_KEY_CACHE_TTL_SECONDS).toBe(600);
		expect(apiKeyCacheTtl(null, now)).toBe(600);
		expect(apiKeyCacheTtl("2026-07-12T12:05:00.000Z", now)).toBe(300);
	});
});
