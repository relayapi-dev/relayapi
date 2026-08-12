import { describe, expect, it, mock } from "bun:test";
import type Stripe from "stripe";
import type { Env } from "../types";

let subscriptionStatuses: Stripe.Subscription.Status[] = [];
let subscriptionRetrieveCalls = 0;
let subscriptionCancelCalls = 0;
let releaseFenceCalls = 0;
let emailCalls = 0;

function subscription(status: Stripe.Subscription.Status) {
	return {
		id: "sub_dunning_race",
		status,
		customer: "cus_dunning_race",
		canceled_at: null,
		trial_end: null,
		cancel_at: null,
		cancel_at_period_end: false,
		metadata: {
			relayapi_managed_by: "relayapi",
			relayapi_role: "base",
		},
		items: {
			data: [
				{
					current_period_start: 1_783_910_400,
					current_period_end: 1_786_588_800,
				},
			],
		},
	};
}

mock.module("../services/stripe", () => ({
	createStripeClient: async () => ({
		invoices: {
			retrieve: async () =>
				({
					parent: {
						type: "subscription_details",
						subscription_details: {
							subscription: "sub_dunning_race",
						},
					},
				}) as Stripe.Invoice,
		},
		subscriptions: {
			retrieve: async () => {
				const status = subscriptionStatuses[subscriptionRetrieveCalls++];
				if (!status) throw new Error("Unexpected Stripe subscription retrieve");
				return subscription(status);
			},
			cancel: async () => {
				subscriptionCancelCalls++;
				return subscription("canceled");
			},
		},
	}),
}));

mock.module("../services/stripe-organization-lease", () => ({
	claimStripeOrganizationFence: async (
		_db: unknown,
		organizationId: string,
		ownerId: string,
	) => ({ organizationId, ownerId, leaseToken: 1 }),
	assertStripeOrganizationFence: async () => {},
	releaseStripeOrganizationFence: async () => {
		releaseFenceCalls++;
	},
}));

mock.module("../services/email", () => ({
	sendPaymentFailedReminder: async () => {
		emailCalls++;
	},
	sendPlanDeactivatedEmail: async () => {
		emailCalls++;
	},
}));

import { deliverDunningEvent } from "../services/dunning";

type Update = Record<string, unknown>;

type DunningTestDb = {
	transaction: <T>(callback: (tx: DunningTestDb) => Promise<T>) => Promise<T>;
	select: () => {
		from: () => {
			where: () => {
				for: () => {
					limit: () => Promise<
						Array<{ id: string; stripeSubscriptionId: string }>
					>;
				};
			};
		};
	};
	update: () => {
		set: (values: Update) => {
			where: () => Promise<never[]>;
		};
	};
};

function createDunningDb() {
	const updates: Update[] = [];
	const db: DunningTestDb = {
		transaction: async <T>(callback: (tx: DunningTestDb) => Promise<T>) =>
			callback(db),
		select: () => ({
			from: () => ({
				where: () => ({
					for: () => ({
						limit: async () => [
							{
								id: "sub_row_dunning_race",
								stripeSubscriptionId: "sub_dunning_race",
							},
						],
					}),
				}),
			}),
		}),
		update: () => ({
			set: (values: Update) => ({
				where: async () => {
					updates.push(values);
					return [];
				},
			}),
		}),
	};
	return { db, updates };
}

function claimedDunningRow() {
	const now = new Date();
	return {
		id: "dun_recovery_race",
		organizationId: "org_dunning_race",
		invoiceId: "inv_dunning_race",
		stripeInvoiceId: "in_dunning_race",
		event: "deactivated_14d",
		status: "processing",
		deliveryIdempotencyKey: "dunning:inv_dunning_race:deactivated_14d",
		dueAt: now,
		providerMessageId: null,
		attempts: 1,
		leaseToken: 1,
		nextAttemptAt: now,
		deadlineAt: new Date(now.getTime() + 24 * 60 * 60_000),
		claimedAt: now,
		leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
		lastError: null,
		deactivationStatus: "pending",
		deactivationOperationId:
			"dunning:inv_dunning_race:deactivated_14d:stripe-cancel",
		deactivationRequestedAt: null,
		deactivationConfirmedAt: null,
		deactivationProviderResponse: null,
		deactivationLastError: null,
		sentAt: null,
		createdAt: now,
		updatedAt: now,
	};
}

describe("dunning recovery canonical-read race", () => {
	for (const [first, second] of [
		["active", "past_due"],
		["trialing", "unpaid"],
	] as const) {
		it(`retries when ${first} changes to ${second} before recovery projection`, async () => {
			subscriptionStatuses = [first, second];
			subscriptionRetrieveCalls = 0;
			subscriptionCancelCalls = 0;
			releaseFenceCalls = 0;
			emailCalls = 0;
			const { db, updates } = createDunningDb();

			await deliverDunningEvent(
				db as never,
				{ STRIPE_SECRET_KEY: "test" } as Env,
				claimedDunningRow() as never,
				{
					billingEmail: "owner@example.com",
					orgName: "Dunning Race",
					invoiceUrl: null,
					stripeInvoiceId: "in_dunning_race",
				},
			);

			expect(subscriptionRetrieveCalls).toBe(2);
			expect(subscriptionCancelCalls).toBe(0);
			expect(emailCalls).toBe(0);
			expect(releaseFenceCalls).toBe(1);
			expect(updates).toHaveLength(1);
			expect(updates[0]).toMatchObject({
				status: "failed",
				leaseExpiresAt: null,
				deactivationStatus: "failed",
				deactivationConfirmedAt: null,
			});
			expect(updates[0]?.nextAttemptAt).toBeInstanceOf(Date);
			expect(updates[0]?.deactivationLastError).toContain(
				"Canonical Stripe state changed during recovery projection",
			);
			expect(
				updates.some(
					(update) =>
						update.status === "sent" ||
						update.deactivationStatus === "succeeded",
				),
			).toBe(false);
		});
	}
});
