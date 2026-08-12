/**
 * Integration tests for multi-step billing flows.
 *
 * These tests exercise the full lifecycle: webhook → DB → KV → usage enforcement.
 * They use the same mock infrastructure as individual tests but chain multiple
 * operations together to verify end-to-end correctness.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

// ── Module mocks (must be before imports of modules under test) ──

const mockNotify = mock(() => Promise.resolve());
mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: mockNotify,
}));

// We need a reference to the mock DB that handleEvent will use
let activeDb: ReturnType<typeof import("./__mocks__/db").createMockDb>;
let canonicalSubscriptionStatus = "active";
let canonicalCancelAtPeriodEnd = false;
let canonicalInvoiceStatus: "open" | "paid" = "open";

mock.module("@relayapi/db", () => {
	const { mockEq } = require("./__mocks__/db");

	// Fake Drizzle table/column objects
	const organizationSubscriptions = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		stripeSubscriptionId: { name: "stripeSubscriptionId" },
		stripeCustomerId: { name: "stripeCustomerId" },
		status: { name: "status" },
		cancelAtPeriodEnd: { name: "cancelAtPeriodEnd" },
		monthlyPriceCents: { name: "monthlyPriceCents" },
		trialEndsAt: { name: "trialEndsAt" },
		currentPeriodStart: { name: "currentPeriodStart" },
		currentPeriodEnd: { name: "currentPeriodEnd" },
		toString: () => "organization_subscriptions",
	};
	const invoices = {
		id: { name: "id" },
		stripeInvoiceId: { name: "stripeInvoiceId" },
		organizationId: { name: "organizationId" },
		toString: () => "invoices",
	};
	const apikey = {
		key: { name: "key" },
		organizationId: { name: "organizationId" },
		toString: () => "apikey",
	};
	const apiRequestLogs = { toString: () => "api_request_logs" };
	const billingOutbox = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		status: { name: "status" },
		attempts: { name: "attempts" },
		leaseToken: { name: "leaseToken" },
		nextAttemptAt: { name: "nextAttemptAt" },
		leaseExpiresAt: { name: "leaseExpiresAt" },
		createdAt: { name: "createdAt" },
		updatedAt: { name: "updatedAt" },
		toString: () => "billing_outbox",
	};
	const stripeEvents = { toString: () => "stripe_events" };
	const billingPeriods = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		toString: () => "billing_periods",
	};
	const billingOperations = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		toString: () => "billing_operations",
	};
	const dunningEvents = {
		id: { name: "id" },
		toString: () => "dunning_events",
	};
	const subscriptionCheckoutOperations = {
		organizationId: { name: "organizationId" },
		stripeCheckoutSessionId: { name: "stripeCheckoutSessionId" },
		toString: () => "subscription_checkout_operations",
	};
	const whatsappPhoneNumbers = {
		id: { name: "id" },
		toString: () => "whatsapp_phone_numbers",
	};

	return {
		createDb: () => activeDb,
		organizationSubscriptions,
		invoices,
		apikey,
		apiRequestLogs,
		billingOutbox,
		stripeEvents,
		billingPeriods,
		billingOperations,
		dunningEvents,
		subscriptionCheckoutOperations,
		whatsappPhoneNumbers,
		eq: (col: unknown, val: unknown) => mockEq(col, val),
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	type Condition = { _filter?: (row: Record<string, unknown>) => boolean };
	return {
		eq: (col: unknown, val: unknown) => mockEq(col, val),
		and: (...conditions: Condition[]) => ({
			_filter: (row: Record<string, unknown>) =>
				conditions.every((condition) => condition._filter?.(row) ?? true),
		}),
		or: (...conditions: Condition[]) => ({
			_filter: (row: Record<string, unknown>) =>
				conditions.some((condition) => condition._filter?.(row) ?? false),
		}),
		inArray: (col: { name: string }, values: unknown[]) => ({
			_filter: (row: Record<string, unknown>) => values.includes(row[col.name]),
		}),
		gt: (col: { name: string }, value: unknown) => ({
			_filter: (row: Record<string, unknown>) =>
				String(row[col.name]) > String(value),
		}),
		lte: (col: { name: string }, value: Date) => ({
			_filter: (row: Record<string, unknown>) => {
				const candidate = row[col.name];
				return candidate == null || (candidate as Date) <= value;
			},
		}),
		asc: (value: unknown) => value,
		sql: Object.assign(
			(_strings: TemplateStringsArray, ..._values: unknown[]) => 1,
			{ join: () => "" },
		),
	};
});

mock.module("../services/stripe", () => ({
	createStripeClient: () => {
		const {
			createMockInvoice,
			createMockSubscription,
		} = require("./__mocks__/stripe");
		return {
			subscriptions: {
				retrieve: async () =>
					createMockSubscription({
						status: canonicalSubscriptionStatus,
						cancel_at_period_end: canonicalCancelAtPeriodEnd,
					}),
			},
			invoices: {
				retrieve: async () =>
					createMockInvoice({ status: canonicalInvoiceStatus }),
			},
		};
	},
}));

mock.module("../services/billing-periods", () => ({
	openBillingPeriod: async () => "bp_flow_test",
	splitBillingPeriod: async () => null,
	shortenOpenBillingPeriod: async () => null,
}));

mock.module("../services/billing-operations", () => ({
	processOverageBillingOperations: async () => 0,
}));

mock.module("../services/invoice-generator", () => ({
	claimBillingPeriod: async () => true,
	invoiceLineMatchesBillingPeriod: () => false,
}));

mock.module("../services/phone-number-operations", () => ({
	wakePhoneAddonBillingReconciliation: async () => {},
}));

mock.module("../services/stripe-organization-lease", () => ({
	claimStripeOrganizationFence: async (
		_db: unknown,
		organizationId: string,
		ownerId: string,
	) => ({ organizationId, ownerId, leaseToken: 1 }),
	assertStripeOrganizationFence: async () => {},
	releaseStripeOrganizationFence: async () => {},
}));

// ── Now import modules under test ──

import { incrementUsage } from "../middleware/usage-tracking";
import { handleEvent } from "../routes/stripe-webhooks";
import { processBillingOutbox } from "../services/billing-outbox";
import type { Env, KVKeyData } from "../types";
import { createMockDb } from "./__mocks__/db";
import { createMockEnv, type MockKV } from "./__mocks__/env";
import {
	createCheckoutCompletedEvent,
	createInvoicePaidEvent,
	createInvoicePaymentFailedEvent,
	createSubscriptionDeletedEvent,
	createSubscriptionUpdatedEvent,
} from "./__mocks__/stripe";

// ── Helpers ──

function seedOrgSub(
	db: ReturnType<typeof createMockDb>,
	overrides?: Record<string, unknown>,
) {
	db._seed("organizationSubscriptions", [
		{
			id: "sub_row_1",
			organizationId: "org_test_123",
			status: "active",
			stripeCustomerId: "cus_test_123",
			stripeSubscriptionId: "sub_test_123",
			cancelAtPeriodEnd: false,
			monthlyPriceCents: 500,
			...overrides,
		},
	]);
}

function seedApiKeys(
	db: ReturnType<typeof createMockDb>,
	kv: MockKV,
	orgId: string,
	plan: "free" | "pro",
) {
	const keyHash = "hashed_key_1";
	db._seed("apikey", [{ key: keyHash, organizationId: orgId }]);
	kv.put(
		`apikey:${keyHash}`,
		JSON.stringify({
			org_id: orgId,
			key_id: "key_1",
			permissions: [],
			expires_at: null,
			plan,
			calls_included: plan === "pro" ? 10_000 : 200,
		} satisfies KVKeyData),
	);
}

// ── Tests ──

let db: ReturnType<typeof createMockDb>;
let kv: MockKV;
let env: Env;

beforeEach(() => {
	const mock = createMockEnv();
	kv = mock.kv;
	env = mock.env;
	db = createMockDb();
	activeDb = db;
	mockNotify.mockClear();
	canonicalSubscriptionStatus = "active";
	canonicalCancelAtPeriodEnd = false;
	canonicalInvoiceStatus = "open";
});

describe("Upgrade flow: checkout → webhook → auth-cache invalidation", () => {
	it("completes upgrade end-to-end", async () => {
		// Start: org has cancelled subscription, free KV keys
		seedOrgSub(db, { status: "cancelled", stripeSubscriptionId: null });
		seedApiKeys(db, kv, "org_test_123", "free");

		// Stripe webhook: checkout completed
		const event = createCheckoutCompletedEvent({
			customerId: "cus_test_123",
			metadata: { organizationId: "org_test_123" },
		});

		await handleEvent(event, env);

		// DB should be updated to active
		const sub = db._getData("organizationSubscriptions")[0] as Record<
			string,
			unknown
		>;
		expect(sub.status).toBe("active");
		expect(sub.stripeSubscriptionId).toBe("sub_test_123");

		// The request commits the effect; the background drain invalidates the
		// stale cache so auth rehydrates the authoritative active row.
		expect(await kv.get("apikey:hashed_key_1", "json")).not.toBeNull();
		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();
	});
});

describe("Cancel at period end → deleted", () => {
	it("keeps pro during cancel period, then downgrades on deletion", async () => {
		seedOrgSub(db);
		seedApiKeys(db, kv, "org_test_123", "pro");

		// Step 1: User cancels at period end
		const updateEvent = createSubscriptionUpdatedEvent({
			status: "active",
			cancelAtPeriodEnd: true,
		});
		canonicalCancelAtPeriodEnd = true;
		await handleEvent(updateEvent, env);

		// DB should have cancelAtPeriodEnd=true, status still active
		let sub = db._getData("organizationSubscriptions")[0] as Record<
			string,
			unknown
		>;
		expect(sub.cancelAtPeriodEnd).toBe(true);
		expect(sub.status).toBe("active");

		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();
		seedApiKeys(db, kv, "org_test_123", "pro");

		// Step 2: Period ends, subscription deleted
		const deleteEvent = createSubscriptionDeletedEvent();
		await handleEvent(deleteEvent, env);

		// DB should be cancelled
		sub = db._getData("organizationSubscriptions")[0] as Record<
			string,
			unknown
		>;
		expect(sub.status).toBe("cancelled");
		expect(sub.stripeSubscriptionId).toBeNull();
		expect(sub.cancelAtPeriodEnd).toBe(false);

		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();
	});
});

describe("Payment failure and recovery", () => {
	it("downgrades on failure, upgrades on recovery", async () => {
		seedOrgSub(db);
		seedApiKeys(db, kv, "org_test_123", "pro");

		// Step 1: Payment fails
		const failEvent = createInvoicePaymentFailedEvent();
		canonicalSubscriptionStatus = "past_due";
		canonicalInvoiceStatus = "open";
		await handleEvent(failEvent, env);

		// DB should be past_due and its stale cached entitlement invalidated.
		let sub = db._getData("organizationSubscriptions")[0] as Record<
			string,
			unknown
		>;
		expect(sub.status).toBe("past_due");
		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();

		// Notification should have been sent
		expect(mockNotify).toHaveBeenCalled();
		seedApiKeys(db, kv, "org_test_123", "free");

		// Step 2: Payment succeeds
		// Need to seed a local invoice for the paid event
		db._seed("invoices", [
			{
				id: "inv_row_1",
				stripeInvoiceId: "in_test_123",
			},
		]);

		const paidEvent = createInvoicePaidEvent();
		canonicalSubscriptionStatus = "active";
		canonicalInvoiceStatus = "paid";
		await handleEvent(paidEvent, env);

		// DB should be active again and the cached free entitlement invalidated.
		sub = db._getData("organizationSubscriptions")[0] as Record<
			string,
			unknown
		>;
		expect(sub.status).toBe("active");
		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();
	});
});

describe("Usage state across plan change", () => {
	it("preserves usage and invalidates stale free entitlement after upgrade", async () => {
		seedOrgSub(db, { status: "cancelled" });
		seedApiKeys(db, kv, "org_test_123", "free");

		// Seed usage at the free limit
		const now = new Date();
		const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
		await kv.put(`usage:org_test_123:${month}`, "200");

		// Usage count should be at limit
		const count = await incrementUsage(
			kv as unknown as KVNamespace,
			"org_test_123",
			1,
		);
		expect(count).toBe(201); // incremented past limit

		// After upgrade webhook
		const event = createCheckoutCompletedEvent({
			metadata: { organizationId: "org_test_123" },
		});
		await handleEvent(event, env);

		const sub = db._getData("organizationSubscriptions")[0];
		expect(sub?.status).toBe("active");
		await processBillingOutbox(env, db as never);
		expect(await kv.get("apikey:hashed_key_1", "json")).toBeNull();
		expect(await kv.get(`usage:org_test_123:${month}`)).toBe("201");
	});
});
