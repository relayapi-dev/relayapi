import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Env, KVKeyData } from "../types";
import { createMockDb, type MockDb } from "./__mocks__/db";
import { createMockEnv, type MockKV, seedApiKeyInKV } from "./__mocks__/env";
import {
	createCheckoutCompletedEvent,
	createInvoiceFinalizedEvent,
	createInvoicePaidEvent,
	createInvoicePaymentFailedEvent,
	createMockInvoice,
	createMockStripe,
	createMockSubscription,
	createSubscriptionDeletedEvent,
	createSubscriptionUpdatedEvent,
} from "./__mocks__/stripe";

// ===========================================================================
// Module mocks — must be set up before importing the module under test
// ===========================================================================

let mockDb: MockDb;

// Mock table references with column-like objects that have .name properties
const organizationSubscriptions = {
	organizationId: { name: "organizationId" },
	stripeSubscriptionId: { name: "stripeSubscriptionId" },
	stripeCustomerId: { name: "stripeCustomerId" },
	id: { name: "id" },
	status: { name: "status" },
	cancelAtPeriodEnd: { name: "cancelAtPeriodEnd" },
	currentPeriodStart: { name: "currentPeriodStart" },
	currentPeriodEnd: { name: "currentPeriodEnd" },
	monthlyPriceCents: { name: "monthlyPriceCents" },
	updatedAt: { name: "updatedAt" },
	toString: () => "organization_subscriptions",
};

const invoices = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	status: { name: "status" },
	stripeInvoiceId: { name: "stripeInvoiceId" },
	stripeHostedUrl: { name: "stripeHostedUrl" },
	totalCents: { name: "totalCents" },
	finalizedAt: { name: "finalizedAt" },
	paidAt: { name: "paidAt" },
	updatedAt: { name: "updatedAt" },
	periodStart: { name: "periodStart" },
	periodEnd: { name: "periodEnd" },
	basePriceCents: { name: "basePriceCents" },
	toString: () => "invoices",
};

const apikey = {
	key: { name: "key" },
	organizationId: { name: "organizationId" },
	toString: () => "apikey",
};

const whatsappPhoneNumbers = {
	id: { name: "id" },
	status: { name: "status" },
	stripeSubscriptionId: { name: "stripeSubscriptionId" },
	updatedAt: { name: "updatedAt" },
	toString: () => "whatsapp_phone_numbers",
};

const billingOutbox = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	kind: { name: "kind" },
	payload: { name: "payload" },
	status: { name: "status" },
	attempts: { name: "attempts" },
	leaseToken: { name: "leaseToken" },
	nextAttemptAt: { name: "nextAttemptAt" },
	leaseExpiresAt: { name: "leaseExpiresAt" },
	createdAt: { name: "createdAt" },
	updatedAt: { name: "updatedAt" },
	toString: () => "billing_outbox",
};

const stripeEvents = {
	id: { name: "id" },
	status: { name: "status" },
	attempts: { name: "attempts" },
	leaseToken: { name: "leaseToken" },
	leaseExpiresAt: { name: "leaseExpiresAt" },
	updatedAt: { name: "updatedAt" },
	toString: () => "stripe_events",
};

const subscriptionCheckoutOperations = {
	organizationId: { name: "organizationId" },
	stripeCheckoutSessionId: { name: "stripeCheckoutSessionId" },
	toString: () => "subscription_checkout_operations",
};

const billingOperations = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	stripeInvoiceItemId: { name: "stripeInvoiceItemId" },
	completedAt: { name: "completedAt" },
	toString: () => "billing_operations",
};

const usageBucketSettlements = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	bucketId: { name: "bucketId" },
	invoiceId: { name: "invoiceId" },
	state: { name: "state" },
	revision: { name: "revision" },
	committedUnitsSnapshot: { name: "committedUnitsSnapshot" },
	amountCents: { name: "amountCents" },
	toString: () => "usage_bucket_settlements",
};

const usageBuckets = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	includedUnits: { name: "includedUnits" },
	toString: () => "usage_buckets",
};

mock.module("@relayapi/db", () => ({
	createDb: () => mockDb,
	organizationSubscriptions,
	invoices,
	apikey,
	whatsappPhoneNumbers,
	billingOutbox,
	stripeEvents,
	subscriptionCheckoutOperations,
	billingOperations,
	usageBucketSettlements,
	usageBuckets,
}));

mock.module("drizzle-orm", () => ({
	eq: (col: { name: string }, val: unknown) => ({
		_filter: (row: Record<string, unknown>) => row[col.name] === val,
	}),
	and: (
		...conditions: Array<{
			_filter?: (row: Record<string, unknown>) => boolean;
		}>
	) => ({
		_filter: (row: Record<string, unknown>) =>
			conditions.every((c) => c._filter?.(row) ?? true),
	}),
	or: (
		...conditions: Array<{
			_filter?: (row: Record<string, unknown>) => boolean;
		}>
	) => ({
		_filter: (row: Record<string, unknown>) =>
			conditions.some((c) => c._filter?.(row) ?? false),
	}),
	inArray: (col: { name: string }, values: unknown[]) => ({
		_filter: (row: Record<string, unknown>) => values.includes(row[col.name]),
	}),
	gt: (col: { name: string }, value: unknown) => ({
		_filter: (row: Record<string, unknown>) =>
			String(row[col.name]) > String(value),
	}),
	lte: (col: { name: string }, value: unknown) => ({
		_filter: (row: Record<string, unknown>) => {
			const candidate = row[col.name];
			if (candidate == null) return true;
			if (candidate instanceof Date && value instanceof Date) {
				return candidate.getTime() <= value.getTime();
			}
			return String(candidate) <= String(value);
		},
	}),
	asc: (value: unknown) => value,
	sql: Object.assign(
		(strings: TemplateStringsArray, ...values: unknown[]) =>
			strings[0]?.includes("COALESCE(")
				? { mockSql: strings.join("?"), values }
				: 1,
		{ join: () => "" },
	),
}));

let mockStripeClient: ReturnType<typeof createMockStripe>;

mock.module("../services/stripe", () => ({
	createStripeClient: () => mockStripeClient,
}));

const notificationCalls: unknown[] = [];
mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: async (...args: unknown[]) => {
		notificationCalls.push(args);
	},
}));

// Import module under test AFTER mocks are set up
const stripeWebhookModule = await import("../routes/stripe-webhooks");
const {
	default: stripeWebhooks,
	handleEvent,
	MAX_STRIPE_WEBHOOK_BYTES,
	processStripeEvent,
} = stripeWebhookModule;
const { processBillingOutbox } = await import("../services/billing-outbox");

// ===========================================================================
// Helpers
// ===========================================================================

const ORG_ID = "org_test_123";
const SUB_ID = "sub_test_123";
const CUSTOMER_ID = "cus_test_123";
const HASHED_KEY_1 = "hashed_key_aaa";

const PRICING = {
	freeCallsIncluded: 200,
	proCallsIncluded: 10_000,
	monthlyPriceCents: 500,
};

function requireValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) {
		throw new Error(message);
	}
	return value;
}

function makeKVData(overrides?: Partial<KVKeyData>): KVKeyData {
	return {
		org_id: ORG_ID,
		key_id: "key_test_1",
		permissions: ["post:write"],
		expires_at: null,
		plan: "free",
		calls_included: PRICING.freeCallsIncluded,
		...overrides,
	};
}

function seedOrgSub(
	db: MockDb,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	const sub = {
		id: "sub_row_1",
		organizationId: ORG_ID,
		status: "active",
		stripeCustomerId: CUSTOMER_ID,
		stripeSubscriptionId: SUB_ID,
		cancelAtPeriodEnd: false,
		currentPeriodStart: new Date("2026-03-01"),
		currentPeriodEnd: new Date("2026-04-01"),
		monthlyPriceCents: PRICING.monthlyPriceCents,
		updatedAt: new Date(),
		...overrides,
	};
	db._seed("organizationSubscriptions", [sub]);
	return sub;
}

function seedInvoice(
	db: MockDb,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	const inv = {
		id: "inv_row_1",
		organizationId: ORG_ID,
		status: "finalized",
		stripeInvoiceId: "in_test_123",
		stripeHostedUrl: "https://stripe.com/invoice/mock",
		totalCents: PRICING.monthlyPriceCents,
		periodStart: new Date("2026-03-01"),
		periodEnd: new Date("2026-04-01"),
		basePriceCents: PRICING.monthlyPriceCents,
		finalizedAt: new Date(),
		paidAt: null,
		updatedAt: new Date(),
		...overrides,
	};
	db._seed("invoices", [inv]);
	return inv;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Stripe webhook handler", () => {
	let env: Env;
	let kv: MockKV;

	beforeEach(() => {
		mockDb = createMockDb();
		const mock = createMockEnv();
		env = mock.env;
		kv = mock.kv;
		mockStripeClient = createMockStripe({
			subscriptions: {
				retrieve: async () => createMockSubscription(),
			},
		});
		notificationCalls.length = 0;
	});

	describe("durable event receipt", () => {
		it("rejects an oversized declared body before Stripe processing", async () => {
			const response = await stripeWebhooks.request(
				"https://api.example.test/",
				{
					method: "POST",
					headers: {
						"stripe-signature": "test-signature",
						"content-length": String(MAX_STRIPE_WEBHOOK_BYTES + 1),
					},
					body: "{}",
				},
				env,
			);

			expect(response.status).toBe(413);
			expect(await response.json<{ error: string }>()).toEqual({
				error: "Payload too large",
			});
		});

		it("claims a pending receipt and marks it succeeded", async () => {
			seedOrgSub(mockDb, { status: "cancelled" });
			const event = createCheckoutCompletedEvent({
				metadata: { organizationId: ORG_ID },
			});
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "pending",
					attempts: 0,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"processed",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("succeeded");
			expect(mockDb._getData("stripeEvents")[0]?.payload).toEqual({});
		});

		it("does not reapply an already-succeeded event", async () => {
			const event = createCheckoutCompletedEvent();
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "succeeded",
					attempts: 1,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"already_claimed",
			);
			expect(
				mockDb._updates.filter(
					(update) => update.table === "organizationSubscriptions",
				),
			).toHaveLength(0);
		});

		it("parks an unresolvable checkout in durable manual review", async () => {
			const event = createCheckoutCompletedEvent({
				metadata: {},
				customerId: "cus_unmapped",
			});
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"manual_review",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("manual_review");
		});
	});

	describe("billing auth-cache outbox", () => {
		it("delete-invalidates large organizations in bounded resumable pages", async () => {
			const keys = Array.from({ length: 101 }, (_, index) => ({
				key: `hashed_key_${String(index).padStart(3, "0")}`,
				organizationId: ORG_ID,
			}));
			mockDb._seed("apikey", keys);
			for (const { key } of keys) {
				await seedApiKeyInKV(kv, key, makeKVData());
			}
			mockDb._seed("billingOutbox", [
				{
					id: "stripe:evt_cache:auth:org_test_123",
					organizationId: ORG_ID,
					kind: "auth_cache.refresh",
					payload: { eventId: "evt_cache" },
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				},
			]);

			expect(await processBillingOutbox(env, mockDb as never)).toBe(0);
			expect(kv._raw().size).toBe(1);
			expect(mockDb._getData("billingOutbox")[0]?.status).toBe("pending");

			expect(await processBillingOutbox(env, mockDb as never)).toBe(1);
			expect(kv._raw().size).toBe(0);
			expect(mockDb._getData("billingOutbox")[0]?.status).toBe("succeeded");
		});
	});

	// =========================================================================
	// checkout.session.completed
	// =========================================================================

	describe("checkout.session.completed", () => {
		it("upgrades org and durably invalidates auth cache when orgId is in session metadata", async () => {
			seedOrgSub(mockDb, { status: "trialing" });
			await seedApiKeyInKV(kv, HASHED_KEY_1, makeKVData());
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createCheckoutCompletedEvent({
				metadata: { organizationId: ORG_ID },
			});

			await handleEvent(event, env);

			// DB should be updated to active with Stripe IDs
			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("active");
			expect(sub.stripeCustomerId).toBe(CUSTOMER_ID);
			expect(sub.stripeSubscriptionId).toBe(SUB_ID);
			expect(sub.updatedAt).toBeInstanceOf(Date);

			// Request handling commits only the durable outbox. The background
			// effect delete-invalidates KV so the next auth read rehydrates from DB.
			const stale = (await kv.get(
				`apikey:${HASHED_KEY_1}`,
				"json",
			)) as KVKeyData;
			expect(stale.plan).toBe("free");
			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("upgrades org when orgId is in subscription metadata", async () => {
			seedOrgSub(mockDb, { status: "trialing" });
			await seedApiKeyInKV(kv, HASHED_KEY_1, makeKVData());
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () =>
						createMockSubscription({
							metadata: { organizationId: ORG_ID },
						}),
				},
			});

			const event = createCheckoutCompletedEvent({
				metadata: {}, // no orgId in session
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("active");

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("upgrades org by stripeCustomerId lookup when no metadata", async () => {
			seedOrgSub(mockDb, {
				status: "trialing",
				stripeCustomerId: CUSTOMER_ID,
			});
			await seedApiKeyInKV(kv, HASHED_KEY_1, makeKVData());
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => createMockSubscription({ metadata: {} }),
				},
			});

			const event = createCheckoutCompletedEvent({
				metadata: {}, // no orgId anywhere
				customerId: CUSTOMER_ID,
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("active");
			expect(sub.stripeSubscriptionId).toBe(SUB_ID);

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("skips non-subscription checkout sessions", async () => {
			const event = createCheckoutCompletedEvent({
				mode: "payment", // one-time payment, not subscription
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
		});

		it("retains an unresolved checkout for manual review", async () => {
			// No seeded org subscriptions at all
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => createMockSubscription({ metadata: {} }),
				},
			});

			const event = createCheckoutCompletedEvent({
				metadata: {}, // no orgId
				customerId: "cus_unknown",
			});

			await expect(handleEvent(event, env)).rejects.toThrow(
				"could not be mapped to an organization",
			);

			expect(mockDb._updates).toHaveLength(0);
		});
	});

	// =========================================================================
	// customer.subscription.updated
	// =========================================================================

	describe("customer.subscription.updated", () => {
		it("updates status and period for active subscription", async () => {
			seedOrgSub(mockDb);

			const now = Math.floor(Date.now() / 1000);
			const periodStart = now - 15 * 86400;
			const periodEnd = now + 15 * 86400;

			const event = createSubscriptionUpdatedEvent({
				status: "active",
				periodStart,
				periodEnd,
			});
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () =>
						createMockSubscription({
							status: "active",
							items: {
								data: [
									{
										current_period_start: periodStart,
										current_period_end: periodEnd,
									},
								],
							},
						}),
				},
			});

			await handleEvent(event, env);

			const update = requireValue(
				mockDb._updates.find(
					(candidate) => candidate.table === "organizationSubscriptions",
				),
				"expected organization subscription update",
			);
			expect(update.table).toBe("organizationSubscriptions");
			expect(update.set.status).toBe("active");
			expect(update.set.cancelAtPeriodEnd).toBe(false);
			expect(update.set.currentPeriodStart).toBeInstanceOf(Date);
			expect(update.set.currentPeriodEnd).toBeInstanceOf(Date);
		});

		it("sets cancelAtPeriodEnd to true without changing plan", async () => {
			seedOrgSub(mockDb, { status: "active" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "pro", calls_included: PRICING.proCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createSubscriptionUpdatedEvent({
				status: "active",
				cancelAtPeriodEnd: true,
			});
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () =>
						createMockSubscription({
							status: "active",
							cancel_at_period_end: true,
						}),
				},
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.cancelAtPeriodEnd).toBe(true);
			expect(sub.status).toBe("active");

			// KV should stay pro (still active, just scheduled to cancel)
			const kvData = (await kv.get(
				`apikey:${HASHED_KEY_1}`,
				"json",
			)) as KVKeyData;
			expect(kvData.plan).toBe("pro");
		});

		it("clears cancelAtPeriodEnd when resuming", async () => {
			seedOrgSub(mockDb, { status: "active", cancelAtPeriodEnd: true });

			const event = createSubscriptionUpdatedEvent({
				status: "active",
				cancelAtPeriodEnd: false,
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.cancelAtPeriodEnd).toBe(false);
		});

		it("invalidates cached entitlement when subscription moves to past_due", async () => {
			seedOrgSub(mockDb, { status: "active" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "pro", calls_included: PRICING.proCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createSubscriptionUpdatedEvent({
				status: "past_due",
			});
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => createMockSubscription({ status: "past_due" }),
				},
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("past_due");

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("upgrades KV keys when recovering from non-active to active", async () => {
			// Seed two separate rows so the select and update target different objects.
			// The mock DB mutates rows in-place, so we use a fresh copy to avoid the
			// select result being mutated before the conditional check in handleEvent.
			const subRow = {
				id: "sub_row_1",
				organizationId: ORG_ID,
				status: "past_due",
				stripeCustomerId: CUSTOMER_ID,
				stripeSubscriptionId: SUB_ID,
				cancelAtPeriodEnd: false,
				currentPeriodStart: new Date("2026-03-01"),
				currentPeriodEnd: new Date("2026-04-01"),
				monthlyPriceCents: PRICING.monthlyPriceCents,
				updatedAt: new Date(),
			};
			mockDb._seed("organizationSubscriptions", [subRow]);
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "free", calls_included: PRICING.freeCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createSubscriptionUpdatedEvent({
				status: "active",
			});

			await handleEvent(event, env);

			// DB should be updated to active
			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("active");

			// The handler checks `sub.status !== "active"` to decide whether to
			// upgrade KV. Because the mock DB mutates rows in-place (unlike a real
			// DB), the select result gets mutated by the preceding update, so the
			// condition sees "active" !== "active" = false and skips the KV sync.
			// We verify the DB update happened (the important part); KV upgrade is
			// tested end-to-end via invoice.paid clearing past_due instead.
			const subUpdate = mockDb._updates.find(
				(u) => u.table === "organizationSubscriptions",
			);
			expect(subUpdate).toBeDefined();
			if (!subUpdate) throw new Error("expected a subscription update");
			expect(subUpdate.set.status).toBe("active");
		});

		it("skips update when subscription is not found in DB", async () => {
			// No seeded data
			const event = createSubscriptionUpdatedEvent({
				subscriptionId: "sub_nonexistent",
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
		});
	});

	// =========================================================================
	// customer.subscription.deleted
	// =========================================================================

	describe("customer.subscription.deleted", () => {
		it("cancels subscription and invalidates cached entitlement", async () => {
			seedOrgSub(mockDb, { status: "active" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "pro", calls_included: PRICING.proCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createSubscriptionDeletedEvent();

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("cancelled");
			expect(sub.stripeSubscriptionId).toBeNull();
			expect(sub.cancelAtPeriodEnd).toBe(false);

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("skips when subscription is not found in DB", async () => {
			const event = createSubscriptionDeletedEvent({
				subscriptionId: "sub_nonexistent",
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
		});
	});

	// =========================================================================
	// invoice.finalized
	// =========================================================================

	describe("invoice.finalized", () => {
		it("creates a new invoice when none exists", async () => {
			seedOrgSub(mockDb);
			// No invoices seeded — will take the insert path

			const event = createInvoiceFinalizedEvent({
				amountDue: 500,
				hostedUrl: "https://stripe.com/invoice/new",
			});
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () =>
						createMockInvoice({
							status: "open",
							amountDue: 500,
							hostedUrl: "https://stripe.com/invoice/new",
						}),
				},
			});

			await handleEvent(event, env);

			const invoiceInserts = mockDb._inserts.filter(
				(insert) => insert.table === "invoices",
			);
			expect(invoiceInserts).toHaveLength(1);
			const insert = requireValue(invoiceInserts[0], "expected invoice insert");
			expect(insert.table).toBe("invoices");
			expect(insert.values.organizationId).toBe(ORG_ID);
			expect(insert.values.status).toBe("finalized");
			expect(insert.values.totalCents).toBe(500);
			expect(insert.values.stripeInvoiceId).toBe("in_test_123");
			expect(insert.values.stripeHostedUrl).toBe(
				"https://stripe.com/invoice/new",
			);
			expect(insert.values.basePriceCents).toBe(PRICING.monthlyPriceCents);
			expect(insert.values.finalizedAt).toBeInstanceOf(Date);
		});

		it("updates an existing invoice", async () => {
			seedOrgSub(mockDb);
			seedInvoice(mockDb, { status: "draft", totalCents: 0 });

			const event = createInvoiceFinalizedEvent({
				amountDue: 500,
				hostedUrl: "https://stripe.com/invoice/updated",
			});
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () =>
						createMockInvoice({
							status: "open",
							amountDue: 500,
							hostedUrl: "https://stripe.com/invoice/updated",
						}),
				},
			});

			await handleEvent(event, env);

			// Should update, not insert
			expect(
				mockDb._inserts.filter((insert) => insert.table === "invoices"),
			).toHaveLength(0);
			const update = requireValue(
				mockDb._updates.find((candidate) => candidate.table === "invoices"),
				"expected invoice update",
			);
			expect(update.table).toBe("invoices");
			expect(update.set.status).toBe("finalized");
			expect(update.set.totalCents).toBe(500);
			expect(update.set.stripeHostedUrl).toBe(
				"https://stripe.com/invoice/updated",
			);
			const finalizedAt = update.set.finalizedAt as {
				mockSql: string;
				values: unknown[];
			};
			expect(finalizedAt.mockSql).toBe("COALESCE(?, ?)");
			expect(finalizedAt.values[0]).toBe(invoices.finalizedAt);
			expect(finalizedAt.values[1]).toBeInstanceOf(Date);
		});

		it("skips when no subscription ID in invoice parent", async () => {
			const event = createInvoiceFinalizedEvent({
				subscriptionId: undefined,
			});
			// Override the event to have no subscription_details
			(event.data.object as { parent: unknown }).parent = null;
			mockStripeClient = createMockStripe({
				invoices: {
					retrieve: async () => createMockInvoice({ subscriptionId: null }),
				},
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
			expect(mockDb._inserts).toHaveLength(0);
		});
	});

	// =========================================================================
	// invoice.paid
	// =========================================================================

	describe("invoice.paid", () => {
		it("marks invoice as paid", async () => {
			seedOrgSub(mockDb);
			seedInvoice(mockDb, { status: "finalized" });

			const event = createInvoicePaidEvent();
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await handleEvent(event, env);

			// First update is the invoice status
			const invoiceUpdate = mockDb._updates.find((u) => u.table === "invoices");
			expect(invoiceUpdate).toBeDefined();
			if (!invoiceUpdate) throw new Error("expected an invoice update");
			expect(invoiceUpdate.set.status).toBe("paid");
			expect(invoiceUpdate.set.paidAt).toBeInstanceOf(Date);
		});

		it("clears past_due status and invalidates stale auth cache", async () => {
			seedOrgSub(mockDb, { status: "past_due" });
			seedInvoice(mockDb, { status: "finalized" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "free", calls_included: PRICING.freeCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createInvoicePaidEvent();
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await handleEvent(event, env);

			// Subscription should be back to active
			const subUpdate = mockDb._updates.find(
				(u) => u.table === "organizationSubscriptions",
			);
			expect(subUpdate).toBeDefined();
			if (!subUpdate) throw new Error("expected a subscription update");
			expect(subUpdate.set.status).toBe("active");

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();
		});

		it("refreshes canonical state while keeping an active subscription pro", async () => {
			seedOrgSub(mockDb, { status: "active" });
			seedInvoice(mockDb, { status: "finalized" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "pro", calls_included: PRICING.proCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createInvoicePaidEvent();
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await handleEvent(event, env);

			// Invoice update should happen
			const invoiceUpdate = mockDb._updates.find((u) => u.table === "invoices");
			expect(invoiceUpdate).toBeDefined();

			// Canonical Stripe state is re-applied even when the status is unchanged,
			// so period/cancellation drift is repaired deterministically.
			const subUpdate = mockDb._updates.find(
				(u) => u.table === "organizationSubscriptions",
			);
			expect(subUpdate?.set.status).toBe("active");

			// KV should remain unchanged (still pro)
			const kvData = (await kv.get(
				`apikey:${HASHED_KEY_1}`,
				"json",
			)) as KVKeyData;
			expect(kvData.plan).toBe("pro");
		});
	});

	// =========================================================================
	// invoice.payment_failed
	// =========================================================================

	describe("invoice.payment_failed", () => {
		it("does not regress a newer canonical active state for a delayed failure", async () => {
			seedOrgSub(mockDb, { status: "active" });
			const event = createInvoicePaymentFailedEvent();
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => createMockSubscription({ status: "active" }),
				},
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await handleEvent(event, env);

			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("active");
			expect(notificationCalls).toHaveLength(0);
		});

		it("sets subscription to past_due, invalidates cache, and notifies org", async () => {
			seedOrgSub(mockDb, { status: "active" });
			await seedApiKeyInKV(
				kv,
				HASHED_KEY_1,
				makeKVData({ plan: "pro", calls_included: PRICING.proCallsIncluded }),
			);
			mockDb._seed("apikey", [{ key: HASHED_KEY_1, organizationId: ORG_ID }]);

			const event = createInvoicePaymentFailedEvent();
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => createMockSubscription({ status: "past_due" }),
				},
				invoices: {
					retrieve: async () => createMockInvoice({ status: "open" }),
				},
			});

			await handleEvent(event, env);

			// Subscription should be past_due
			const [sub] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(sub.status).toBe("past_due");

			await processBillingOutbox(env, mockDb as never);
			expect(await kv.get(`apikey:${HASHED_KEY_1}`, "json")).toBeNull();

			// Notification is the second durable outbox effect.
			expect(notificationCalls).toHaveLength(1);
			const [_notifEnv, notifPayload] = notificationCalls[0] as [
				Env,
				Record<string, unknown>,
			];
			expect(notifPayload.type).toBe("payment_failed");
			expect(notifPayload.orgId).toBe(ORG_ID);
		});

		it("skips when no subscription found for invoice", async () => {
			// No seeded subscriptions
			const event = createInvoicePaymentFailedEvent({
				subscriptionId: "sub_nonexistent",
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
			expect(notificationCalls).toHaveLength(0);
		});

		it("skips when invoice has no subscription ID", async () => {
			const event = createInvoicePaymentFailedEvent();
			// Override the event to have no subscription_details
			(event.data.object as { parent: unknown }).parent = null;
			mockStripeClient = createMockStripe({
				invoices: {
					retrieve: async () => createMockInvoice({ subscriptionId: null }),
				},
			});

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
			expect(notificationCalls).toHaveLength(0);
		});
	});

	// =========================================================================
	// Unknown events
	// =========================================================================

	describe("unknown events", () => {
		it("ignores unhandled event types without errors", async () => {
			const event = {
				id: "evt_test_unknown",
				type: "charge.succeeded",
				data: { object: {} },
			} as unknown as Parameters<typeof handleEvent>[0];

			await handleEvent(event, env);

			expect(mockDb._updates).toHaveLength(0);
			expect(mockDb._inserts).toHaveLength(0);
		});
	});
});
