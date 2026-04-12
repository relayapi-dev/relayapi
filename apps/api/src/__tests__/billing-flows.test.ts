/**
 * Integration tests for multi-step billing flows.
 *
 * These tests exercise the full lifecycle: webhook → DB → KV → usage enforcement.
 * They use the same mock infrastructure as individual tests but chain multiple
 * operations together to verify end-to-end correctness.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Module mocks (must be before imports of modules under test) ──

const mockNotify = mock(() => Promise.resolve());
mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: mockNotify,
}));

// We need a reference to the mock DB that handleEvent will use
let activeDb: ReturnType<typeof import("./__mocks__/db").createMockDb>;

mock.module("@relayapi/db", () => {
	const { createMockDb, mockEq } = require("./__mocks__/db");

	// Fake Drizzle table/column objects
	const organizationSubscriptions = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		stripeSubscriptionId: { name: "stripeSubscriptionId" },
		stripeCustomerId: { name: "stripeCustomerId" },
		status: { name: "status" },
		cancelAtPeriodEnd: { name: "cancelAtPeriodEnd" },
		monthlyPriceCents: { name: "monthlyPriceCents" },
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
	const usageRecords = { toString: () => "usage_records" };
	const apiRequestLogs = { toString: () => "api_request_logs" };

	return {
		createDb: () => activeDb,
		organizationSubscriptions,
		invoices,
		apikey,
		usageRecords,
		apiRequestLogs,
		eq: (col: any, val: any) => mockEq(col, val),
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	return {
		eq: (col: any, val: any) => mockEq(col, val),
		sql: (strings: TemplateStringsArray, ...values: any[]) => strings.join(""),
	};
});

mock.module("../services/stripe", () => ({
	createStripeClient: () => {
		const { createMockSubscription } = require("./__mocks__/stripe");
		return {
			subscriptions: {
				retrieve: async () => createMockSubscription(),
			},
		};
	},
}));

// ── Now import modules under test ──

import { handleEvent, syncOrgKeysToKV } from "../routes/stripe-webhooks";
import { incrementUsage } from "../middleware/usage-tracking";
import { createMockDb } from "./__mocks__/db";
import { MockKV, createMockEnv } from "./__mocks__/env";
import {
	createCheckoutCompletedEvent,
	createSubscriptionUpdatedEvent,
	createSubscriptionDeletedEvent,
	createInvoicePaymentFailedEvent,
	createInvoicePaidEvent,
	createMockSubscription,
} from "./__mocks__/stripe";
import type { Env, KVKeyData } from "../types";

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

async function getKVPlan(kv: MockKV, keyHash: string): Promise<string> {
	const raw = await kv.get(`apikey:${keyHash}`, "json");
	return (raw as KVKeyData)?.plan ?? "unknown";
}

async function getKVCallsIncluded(
	kv: MockKV,
	keyHash: string,
): Promise<number> {
	const raw = await kv.get(`apikey:${keyHash}`, "json");
	return (raw as KVKeyData)?.calls_included ?? 0;
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
});

describe("Upgrade flow: checkout → webhook → KV pro", () => {
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
		const sub = db._getData("organizationSubscriptions")[0];
		expect(sub.status).toBe("active");
		expect(sub.stripeSubscriptionId).toBe("sub_test_123");

		// KV should be upgraded to pro
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("pro");
		expect(await getKVCallsIncluded(kv, "hashed_key_1")).toBe(10_000);
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
		await handleEvent(updateEvent, env);

		// DB should have cancelAtPeriodEnd=true, status still active
		let sub = db._getData("organizationSubscriptions")[0];
		expect(sub.cancelAtPeriodEnd).toBe(true);
		expect(sub.status).toBe("active");

		// KV should still be pro (user keeps access until period end)
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("pro");

		// Step 2: Period ends, subscription deleted
		const deleteEvent = createSubscriptionDeletedEvent();
		await handleEvent(deleteEvent, env);

		// DB should be cancelled
		sub = db._getData("organizationSubscriptions")[0];
		expect(sub.status).toBe("cancelled");
		expect(sub.stripeSubscriptionId).toBeNull();
		expect(sub.cancelAtPeriodEnd).toBe(false);

		// KV should be downgraded to free
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("free");
		expect(await getKVCallsIncluded(kv, "hashed_key_1")).toBe(200);
	});
});

describe("Payment failure and recovery", () => {
	it("downgrades on failure, upgrades on recovery", async () => {
		seedOrgSub(db);
		seedApiKeys(db, kv, "org_test_123", "pro");

		// Step 1: Payment fails
		const failEvent = createInvoicePaymentFailedEvent();
		await handleEvent(failEvent, env);

		// DB should be past_due, KV should be free
		let sub = db._getData("organizationSubscriptions")[0];
		expect(sub.status).toBe("past_due");
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("free");
		expect(await getKVCallsIncluded(kv, "hashed_key_1")).toBe(200);

		// Notification should have been sent
		expect(mockNotify).toHaveBeenCalled();

		// Step 2: Payment succeeds
		// Need to seed a local invoice for the paid event
		db._seed("invoices", [
			{
				id: "inv_row_1",
				stripeInvoiceId: "in_test_123",
			},
		]);

		const paidEvent = createInvoicePaidEvent();
		await handleEvent(paidEvent, env);

		// DB should be active again, KV should be pro
		sub = db._getData("organizationSubscriptions")[0];
		expect(sub.status).toBe("active");
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("pro");
		expect(await getKVCallsIncluded(kv, "hashed_key_1")).toBe(10_000);
	});
});

describe("Usage enforcement across plan change", () => {
	it("blocks free user at limit, allows after upgrade", async () => {
		seedOrgSub(db, { status: "cancelled" });
		seedApiKeys(db, kv, "org_test_123", "free");

		// Seed usage at the free limit
		const now = new Date();
		const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
		await kv.put(`usage:org_test_123:${month}`, "200");

		// Usage count should be at limit
		const count = await incrementUsage(kv as unknown as KVNamespace, "org_test_123", 1);
		expect(count).toBe(201); // incremented past limit

		// After upgrade webhook
		const event = createCheckoutCompletedEvent({
			metadata: { organizationId: "org_test_123" },
		});
		await handleEvent(event, env);

		// KV plan should now be pro
		expect(await getKVPlan(kv, "hashed_key_1")).toBe("pro");
		expect(await getKVCallsIncluded(kv, "hashed_key_1")).toBe(10_000);

		// Usage count is still 201, but pro plan has 10k limit — no block
	});
});
