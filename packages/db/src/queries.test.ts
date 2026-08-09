import { describe, expect, it } from "bun:test";
import {
	countFreeOwnedOrganizations,
	type OwnedOrganizationBillingProjection,
} from "./queries";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function subscription(
	overrides: Partial<OwnedOrganizationBillingProjection> = {},
): OwnedOrganizationBillingProjection {
	return {
		role: "owner",
		status: null,
		source: null,
		stripeSubscriptionId: null,
		trialEndsAt: null,
		delinquentAt: null,
		graceEndsAt: null,
		currentPeriodStart: null,
		currentPeriodEnd: null,
		...overrides,
	};
}

describe("free-organization ownership quota", () => {
	it("counts compound owners while excluding non-owner memberships", () => {
		expect(
			countFreeOwnedOrganizations(
				[
					subscription({ role: "admin, owner" }),
					subscription({ role: "member,admin" }),
					subscription({ role: "homeowner" }),
				],
				NOW,
			),
		).toBe(1);
	});

	it("does not charge paid-equivalent entitlements against the free quota", () => {
		expect(
			countFreeOwnedOrganizations(
				[
					subscription({
						status: "active",
						source: "stripe",
						stripeSubscriptionId: "sub_active",
					}),
					subscription({ status: "active", source: "complimentary" }),
					subscription({
						status: "trialing",
						source: "stripe",
						stripeSubscriptionId: "sub_trial",
						trialEndsAt: new Date("2026-08-09T12:00:00.000Z"),
					}),
					subscription({
						status: "past_due",
						source: "stripe",
						stripeSubscriptionId: "sub_grace",
						delinquentAt: new Date("2026-08-07T12:00:00.000Z"),
						graceEndsAt: new Date("2026-08-21T12:00:00.000Z"),
					}),
				],
				NOW,
			),
		).toBe(0);
	});

	it("counts expired or unproven paid states as free", () => {
		expect(
			countFreeOwnedOrganizations(
				[
					subscription({
						status: "trialing",
						source: "stripe",
						stripeSubscriptionId: "sub_expired_trial",
						trialEndsAt: new Date("2026-08-08T11:59:59.000Z"),
					}),
					subscription({
						status: "past_due",
						source: "stripe",
						stripeSubscriptionId: "sub_expired_grace",
						delinquentAt: new Date("2026-07-24T12:00:00.000Z"),
						graceEndsAt: new Date("2026-08-07T12:00:00.000Z"),
					}),
					subscription({
						status: "active",
						source: "stripe",
						stripeSubscriptionId: null,
					}),
				],
				NOW,
			),
		).toBe(3);
	});
});
