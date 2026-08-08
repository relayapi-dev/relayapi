import { describe, expect, it } from "bun:test";
import {
	API_KEY_CACHE_TTL_SECONDS,
	apiKeyCacheTtl,
	dailyToolLimitForPlan,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";

const now = new Date("2026-07-12T12:00:00.000Z");

describe("shared billing policy", () => {
	it("requires explicit provider authority for active Stripe entitlement", () => {
		expect(getBillingPolicy({ status: "active" }, now)).toMatchObject({
			entitlement: "free",
			billable: false,
		});
		expect(
			getBillingPolicy(
				{ status: "active", source: "stripe" },
				now,
			),
		).toMatchObject({ entitlement: "free", billable: false });
		expect(
			getBillingPolicy(
				{
					status: "active",
					source: "stripe",
					stripeSubscriptionId: "sub_123",
				},
				now,
			),
		).toMatchObject({ entitlement: "pro", billable: true });
		expect(
			getBillingPolicy(
				{ status: "active", source: "complimentary" },
				now,
			),
		).toMatchObject({ entitlement: "pro", billable: false });
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
			).entitlement,
		).toBe("free");
		expect(
			getBillingPolicy(
				{
					status: "trialing",
					source: "stripe",
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
				source: "stripe",
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

	it("uses only a currently active period as usage authority", () => {
		for (const [currentPeriodStart, currentPeriodEnd] of [
			["2026-07-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z"],
			["2026-06-01T00:00:00.000Z", "2026-07-12T12:00:00.000Z"],
		] as const) {
			expect(
				getBillingPolicy(
					{
						status: "active",
						source: "stripe",
						stripeSubscriptionId: "sub_123",
						currentPeriodStart,
						currentPeriodEnd,
					},
					now,
				).usagePeriod,
			).toBeNull();
		}
	});

	it("preserves Pro features but not billability during the exact grace window", () => {
		const inGrace = getBillingPolicy(
			{
				status: "past_due",
				source: "stripe",
				stripeSubscriptionId: "sub_123",
				delinquentAt: "2026-07-01T00:00:00.000Z",
				graceEndsAt: "2026-07-15T00:00:00.000Z",
				currentPeriodStart: "2026-07-01T00:00:00.000Z",
				currentPeriodEnd: "2026-08-01T00:00:00.000Z",
			},
			now,
		);
		expect(inGrace).toMatchObject({
			entitlement: "pro",
			billable: false,
			quotaMode: "hard",
			reason: "past_due_grace",
		});
		expect(inGrace.usagePeriod).not.toBeNull();
		expect(
			getBillingPolicy(
				{
					status: "past_due",
					source: "complimentary",
					stripeSubscriptionId: "sub_malformed",
					delinquentAt: "2026-07-01T00:00:00.000Z",
					graceEndsAt: "2026-07-15T00:00:00.000Z",
				},
				now,
			).entitlement,
		).toBe("free");

		expect(
			getBillingPolicy(
				{
					status: "past_due",
					source: "stripe",
					stripeSubscriptionId: "sub_123",
					delinquentAt: "2026-07-01T00:00:00.000Z",
					graceEndsAt: now,
				},
				now,
			),
		).toMatchObject({
			entitlement: "free",
			billable: false,
			reason: "inactive",
			usagePeriod: null,
		});
		expect(
			getBillingPolicy(
				{
					status: "past_due",
					source: "stripe",
					stripeSubscriptionId: "sub_123",
					graceEndsAt: "2026-07-15T00:00:00.000Z",
				},
				now,
			).entitlement,
		).toBe("free");
	});

	it("centralizes the auth-cache backstop at ten minutes", () => {
		expect(API_KEY_CACHE_TTL_SECONDS).toBe(600);
		expect(apiKeyCacheTtl(null, now)).toBe(600);
		expect(apiKeyCacheTtl("2026-07-12T12:05:00.000Z", now)).toBe(300);
	});

	it("derives daily tool limits from the plan unless an explicit override exists", () => {
		expect(dailyToolLimitForPlan("free", null)).toBe(
			PRICING.freeDailyToolLimit,
		);
		expect(dailyToolLimitForPlan("pro", undefined)).toBe(
			PRICING.proDailyToolLimit,
		);
		expect(dailyToolLimitForPlan("pro", 0)).toBe(0);
		expect(dailyToolLimitForPlan("free", 37)).toBe(37);
	});
});
