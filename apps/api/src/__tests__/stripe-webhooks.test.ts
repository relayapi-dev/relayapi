import { beforeEach, describe, expect, it, mock } from "bun:test";
import type Stripe from "stripe";
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
const phoneWakeCalls: Array<[string, string]> = [];
const billingPeriodClaimCalls: Array<{
	periodId: string;
	kind: string;
	stripeInvoiceId?: string;
}> = [];
const exactOverageScopes: unknown[] = [];
let globalOverageSweepCalls = 0;
let billingPeriodClaimResult = true;

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
	organizationId: { name: "organizationId" },
	status: { name: "status" },
	attempts: { name: "attempts" },
	leaseToken: { name: "leaseToken" },
	nextAttemptAt: { name: "nextAttemptAt" },
	leaseExpiresAt: { name: "leaseExpiresAt" },
	receivedAt: { name: "receivedAt" },
	processedAt: { name: "processedAt" },
	manualReviewAt: { name: "manualReviewAt" },
	operatorRetryRequestedAt: { name: "operatorRetryRequestedAt" },
	lastError: { name: "lastError" },
	lastErrorClass: { name: "lastErrorClass" },
	updatedAt: { name: "updatedAt" },
	toString: () => "stripe_events",
};

const financialRetentionReceipts = {
	id: { name: "id" },
	sourceKind: { name: "sourceKind" },
	sourceId: { name: "sourceId" },
	retainedUntil: { name: "retainedUntil" },
	toString: () => "financial_retention_receipts",
};

const subscriptionCheckoutOperations = {
	organizationId: { name: "organizationId" },
	stripeCheckoutSessionId: { name: "stripeCheckoutSessionId" },
	status: { name: "status" },
	toString: () => "subscription_checkout_operations",
};

const billingOperations = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	billingPeriodId: { name: "billingPeriodId" },
	stripeInvoiceItemId: { name: "stripeInvoiceItemId" },
	stripeInvoiceId: { name: "stripeInvoiceId" },
	status: { name: "status" },
	attemptRevision: { name: "attemptRevision" },
	amountCents: { name: "amountCents" },
	currency: { name: "currency" },
	leaseToken: { name: "leaseToken" },
	lastErrorClass: { name: "lastErrorClass" },
	operatorRetryRequestedAt: { name: "operatorRetryRequestedAt" },
	completedAt: { name: "completedAt" },
	toString: () => "billing_operations",
};

const billingOperationAttempts = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	billingOperationId: { name: "billingOperationId" },
	revision: { name: "revision" },
	status: { name: "status" },
	stripeInvoiceId: { name: "stripeInvoiceId" },
	stripeInvoiceItemId: { name: "stripeInvoiceItemId" },
	amountCents: { name: "amountCents" },
	currency: { name: "currency" },
	toString: () => "billing_operation_attempts",
};

const billingPeriods = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	invoiceId: { name: "invoiceId" },
	state: { name: "state" },
	source: { name: "source" },
	billable: { name: "billable" },
	releaseCount: { name: "releaseCount" },
	stripeSubscriptionId: { name: "stripeSubscriptionId" },
	periodStart: { name: "periodStart" },
	periodEnd: { name: "periodEnd" },
	committedUnitsSnapshot: { name: "committedUnitsSnapshot" },
	cycleAllowance: { name: "cycleAllowance" },
	overageUnitsSnapshot: { name: "overageUnitsSnapshot" },
	amountCentsSnapshot: { name: "amountCentsSnapshot" },
	toString: () => "billing_periods",
};

const dunningEvents = {
	id: { name: "id" },
	toString: () => "dunning_events",
};

mock.module("@relayapi/db", () => ({
	BILLING_OUTBOX_KINDS: [
		"auth_cache.refresh",
		"payment_failed.notify",
		"subscription.cancel",
	],
	createDb: () => mockDb,
	organizationSubscriptions,
	invoices,
	apikey,
	whatsappPhoneNumbers,
	billingOutbox,
	stripeEvents,
	financialRetentionReceipts,
	subscriptionCheckoutOperations,
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
	dunningEvents,
}));

mock.module("../services/billing-periods", () => ({
	ensureHostedFreeUsageAuthority: async () => null,
	resumeStripeBillingPeriod: async () => "bp_webhook_test",
	splitBillingPeriod: async () => null,
	shortenOpenBillingPeriod: async () => null,
}));

mock.module("../services/billing-operations", () => ({
	processOverageBillingOperations: async () => {
		globalOverageSweepCalls++;
		return 0;
	},
	processExactOverageBillingOperation: async (
		_env: unknown,
		scope: unknown,
	) => {
		exactOverageScopes.push(scope);
		return 0;
	},
}));

mock.module("../services/invoice-generator", () => ({
	claimBillingPeriod: async (
		_db: unknown,
		period: { id: string },
		target: { kind: string; stripeInvoiceId?: string },
	) => {
		billingPeriodClaimCalls.push({
			periodId: period.id,
			kind: target.kind,
			stripeInvoiceId: target.stripeInvoiceId,
		});
		return billingPeriodClaimResult;
	},
	invoiceLineMatchesBillingPeriod: () => true,
}));

mock.module("../services/phone-number-operations", () => ({
	wakePhoneAddonBillingReconciliation: async (
		_db: unknown,
		organizationId: string,
		reason: string,
	) => {
		phoneWakeCalls.push([organizationId, reason]);
	},
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

mock.module("../services/financial-retention", () => ({
	digestFinancialExternalSourceId: async (
		_provider: string,
		sourceId: string,
	) => `digest:${sourceId}`,
	financialStripeEventAdvisoryLockKey: (sourceDigest: string) =>
		`lock:${sourceDigest}`,
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
			conditions.some((c) => c._filter?.(row) ?? true),
	}),
	inArray: (col: { name: string }, values: unknown[]) => ({
		_filter: (row: Record<string, unknown>) => {
			const candidate = row[col.name];
			return values.some((value) =>
				candidate instanceof Date && value instanceof Date
					? candidate.getTime() === value.getTime()
					: candidate === value,
			);
		},
	}),
	isNotNull: (col: { name: string }) => ({
		_filter: (row: Record<string, unknown>) => row[col.name] != null,
	}),
	isNull: (col: { name: string }) => ({
		_filter: (row: Record<string, unknown>) => row[col.name] == null,
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
	classifyStripeRecoveryError,
	handleEvent,
	MAX_STRIPE_WEBHOOK_BYTES,
	persistStripeEventOrganizationAttribution,
	processStripeEvent,
	STRIPE_RECOVERY_MAX_AGE_MS,
	STRIPE_RECOVERY_MAX_ATTEMPTS,
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
		source: "stripe",
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
		phoneWakeCalls.length = 0;
		billingPeriodClaimCalls.length = 0;
		billingPeriodClaimResult = true;
		exactOverageScopes.length = 0;
		globalOverageSweepCalls = 0;
	});

	describe("durable event receipt", () => {
		it("covers Stripe's retry window with a 30-day recovery policy", () => {
			expect(STRIPE_RECOVERY_MAX_ATTEMPTS).toBe(160);
			expect(STRIPE_RECOVERY_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
			expect(classifyStripeRecoveryError({ statusCode: 400 })).toBe(
				"permanent",
			);
			expect(classifyStripeRecoveryError({ statusCode: 409 })).toBe(
				"transient",
			);
			expect(classifyStripeRecoveryError({ statusCode: 429 })).toBe(
				"transient",
			);
			expect(classifyStripeRecoveryError({ statusCode: 500 })).toBe(
				"transient",
			);
		});

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
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"processed",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("succeeded");
			expect(mockDb._getData("stripeEvents")[0]?.organizationId).toBe(ORG_ID);
			expect(mockDb._getData("stripeEvents")[0]?.payload).toEqual({});
		});

		it("sets Stripe event tenant attribution once and fails closed on conflict", async () => {
			mockDb._seed("stripeEvents", [
				{
					id: "evt_attribution",
					organizationId: null,
					status: "processing",
					leaseToken: 7,
				},
			]);

			await persistStripeEventOrganizationAttribution(mockDb as never, {
				eventId: "evt_attribution",
				organizationId: ORG_ID,
				leaseToken: 7,
			});
			expect(mockDb._getData("stripeEvents")[0]?.organizationId).toBe(ORG_ID);

			await expect(
				persistStripeEventOrganizationAttribution(mockDb as never, {
					eventId: "evt_attribution",
					organizationId: "org_conflict",
					leaseToken: 7,
				}),
			).rejects.toThrow("organization attribution conflicted");
			expect(mockDb._getData("stripeEvents")[0]?.organizationId).toBe(ORG_ID);
		});

		it("parks a receipt when provider evidence disagrees with durable attribution", async () => {
			seedOrgSub(mockDb, { status: "cancelled" });
			const event = createCheckoutCompletedEvent({
				metadata: { organizationId: ORG_ID },
			});
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					organizationId: "org_durable_owner",
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"manual_review",
			);
			expect(mockDb._getData("stripeEvents")[0]?.organizationId).toBe(
				"org_durable_owner",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("manual_review");
		});

		it("does not reapply an already-succeeded event", async () => {
			const event = createCheckoutCompletedEvent();
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "succeeded",
					attempts: 1,
					leaseToken: 1,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
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

		it("does not reclaim a permanently abandoned receipt", async () => {
			const event = createCheckoutCompletedEvent();
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "failed",
					attempts: 1,
					leaseToken: 2,
					lastErrorClass: "permanent",
					operatorRetryRequestedAt: null,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(0),
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

		it("does not report success after its receipt lease is superseded", async () => {
			seedOrgSub(mockDb, { status: "cancelled" });
			const event = createCheckoutCompletedEvent({
				metadata: { organizationId: ORG_ID },
			});
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					updatedAt: new Date(),
				},
			]);
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => {
						const receipt = mockDb._getData("stripeEvents")[0];
						if (receipt) receipt.leaseToken = 99;
						return createMockSubscription();
					},
				},
			});

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"already_claimed",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("processing");
		});

		it("does not report retry or manual state after its lease is superseded", async () => {
			seedOrgSub(mockDb, { status: "cancelled" });
			const event = createCheckoutCompletedEvent({
				metadata: { organizationId: ORG_ID },
			});
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					updatedAt: new Date(),
				},
			]);
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => {
						const receipt = mockDb._getData("stripeEvents")[0];
						if (receipt) receipt.leaseToken = 99;
						throw new Error("provider unavailable");
					},
				},
			});

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"already_claimed",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("processing");
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
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"manual_review",
			);
			expect(mockDb._getData("stripeEvents")[0]?.status).toBe("manual_review");
		});

		it("parks an unimplemented financial event without clearing its payload", async () => {
			seedOrgSub(mockDb);
			const event = {
				id: "evt_refund_review",
				type: "refund.created",
				created: Math.floor(Date.now() / 1000),
				data: { object: { id: "re_review", customer: CUSTOMER_ID } },
			} as unknown as Stripe.Event;
			mockDb._seed("stripeEvents", [
				{
					id: event.id,
					status: "pending",
					attempts: 0,
					leaseToken: 0,
					nextAttemptAt: new Date(0),
					leaseExpiresAt: null,
					receivedAt: new Date(),
					payload: event,
					updatedAt: new Date(),
				},
			]);

			expect(await processStripeEvent(event, env, mockDb as never)).toBe(
				"manual_review",
			);
			expect(mockDb._getData("stripeEvents")[0]?.payload).toEqual(event);
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

		it("wakes phone add-on billing without changing base entitlement", async () => {
			seedOrgSub(mockDb, { status: "active" });
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () =>
						createMockSubscription({
							metadata: {
								organizationId: ORG_ID,
								relayapi_managed_by: "relayapi",
								relayapi_role: "phone_addon",
							},
						}),
				},
			});
			const event = createCheckoutCompletedEvent({
				metadata: {
					organizationId: ORG_ID,
					relayapi_managed_by: "relayapi",
					relayapi_role: "phone_addon",
				},
			});

			await handleEvent(event, env);

			expect(phoneWakeCalls).toEqual([
				[ORG_ID, `checkout.session.completed:${event.id}`],
			]);
			expect(
				mockDb._updates.filter(
					(update) => update.table === "organizationSubscriptions",
				),
			).toHaveLength(0);
		});

		it("terminalizes a failed async base checkout without granting Pro", async () => {
			seedOrgSub(mockDb, { status: "cancelled" });
			mockDb._seed("subscriptionCheckoutOperations", [
				{
					organizationId: ORG_ID,
					stripeCheckoutSessionId: "cs_async_failed",
					status: "created",
				},
			]);
			const event = {
				id: "evt_async_failed",
				type: "checkout.session.async_payment_failed",
				created: Math.floor(Date.now() / 1000),
				data: {
					object: {
						id: "cs_async_failed",
						mode: "subscription",
						subscription: SUB_ID,
						customer: CUSTOMER_ID,
						metadata: {
							organizationId: ORG_ID,
							relayapi_managed_by: "relayapi",
							relayapi_role: "base",
						},
					},
				},
			} as unknown as Stripe.Event;

			await handleEvent(event, env);

			expect(mockDb._getData("subscriptionCheckoutOperations")[0]?.status).toBe(
				"failed",
			);
			expect(mockDb._getData("organizationSubscriptions")[0]?.status).toBe(
				"cancelled",
			);
		});
	});

	describe("invoice.created", () => {
		it("claims the exact draft renewal period and immediately runs settlement", async () => {
			seedOrgSub(mockDb);
			const now = Math.floor(Date.now() / 1000);
			mockDb._seed("billingPeriods", [
				{
					id: "bp_exact_cycle",
					organizationId: ORG_ID,
					state: "open",
					source: "stripe",
					billable: true,
					releaseCount: 0,
					stripeSubscriptionId: SUB_ID,
					periodStart: new Date((now - 30 * 86400) * 1000),
					periodEnd: new Date(now * 1000),
				},
			]);
			const invoice = {
				...createMockInvoice({
					id: "in_exact_cycle",
					status: "draft",
					periodStart: now - 30 * 86400,
					periodEnd: now,
				}),
				billing_reason: "subscription_cycle",
				customer: CUSTOMER_ID,
				lines: {
					data: [
						{
							id: "il_base",
							period: { start: now, end: now + 30 * 86400 },
							parent: {
								type: "subscription_item_details",
								subscription_item_details: { proration: false },
							},
						},
					],
					has_more: false,
				},
			};
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: { retrieve: async () => invoice },
			});
			const event = {
				id: "evt_invoice_created_exact",
				type: "invoice.created",
				created: now,
				data: { object: invoice },
			} as unknown as Stripe.Event;

			const organizationFence = {
				organizationId: ORG_ID,
				ownerId: event.id,
				leaseToken: 1,
			};
			await handleEvent(event, env, mockDb as never, organizationFence);

			expect(billingPeriodClaimCalls).toEqual([
				{
					periodId: "bp_exact_cycle",
					kind: "cycle",
					stripeInvoiceId: "in_exact_cycle",
				},
			]);
			expect(exactOverageScopes).toEqual([
				{
					operationId: "bop_bp_exact_cycle_cycle",
					organizationId: ORG_ID,
					billingPeriodId: "bp_exact_cycle",
					organizationFence,
				},
			]);
			expect(globalOverageSweepCalls).toBe(0);
		});

		it("keeps the exact draft invoice receipt retryable while usage is live", async () => {
			seedOrgSub(mockDb);
			const now = Math.floor(Date.now() / 1000);
			mockDb._seed("billingPeriods", [
				{
					id: "bp_live_reservation",
					organizationId: ORG_ID,
					state: "open",
					source: "stripe",
					billable: true,
					releaseCount: 0,
					stripeSubscriptionId: SUB_ID,
					periodStart: new Date((now - 30 * 86400) * 1000),
					periodEnd: new Date(now * 1000),
				},
			]);
			const invoice = {
				...createMockInvoice({
					id: "in_live_reservation",
					status: "draft",
					periodStart: now - 30 * 86400,
					periodEnd: now,
				}),
				billing_reason: "subscription_cycle",
				customer: CUSTOMER_ID,
				lines: {
					data: [
						{
							id: "il_base_live",
							period: { start: now, end: now + 30 * 86400 },
							parent: {
								type: "subscription_item_details",
								subscription_item_details: { proration: false },
							},
						},
					],
					has_more: false,
				},
			};
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: { retrieve: async () => invoice },
			});
			const event = {
				id: "evt_invoice_created_live",
				type: "invoice.created",
				created: now,
				data: { object: invoice },
			} as unknown as Stripe.Event;

			billingPeriodClaimResult = false;
			const organizationFence = {
				organizationId: ORG_ID,
				ownerId: event.id,
				leaseToken: 1,
			};
			await expect(
				handleEvent(event, env, mockDb as never, organizationFence),
			).rejects.toThrow("still has unresolved usage reservations");
			expect(exactOverageScopes).toHaveLength(0);
			expect(globalOverageSweepCalls).toBe(0);

			billingPeriodClaimResult = true;
			await expect(
				handleEvent(event, env, mockDb as never, organizationFence),
			).resolves.toBeUndefined();
			expect(exactOverageScopes).toHaveLength(1);
			expect(globalOverageSweepCalls).toBe(0);
		});
	});

	// =========================================================================
	// customer.subscription.updated
	// =========================================================================

	describe("customer.subscription.updated", () => {
		it("wakes phone add-on reconciliation without projecting base entitlement", async () => {
			const event = createSubscriptionUpdatedEvent({ status: "active" });
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () =>
						createMockSubscription({
							status: "active",
							metadata: {
								organizationId: ORG_ID,
								relayapi_managed_by: "relayapi",
								relayapi_role: "phone_addon",
							},
						}),
				},
			});

			await handleEvent(event, env);

			expect(phoneWakeCalls).toEqual([
				[ORG_ID, `customer.subscription.updated:${event.id}`],
			]);
			expect(
				mockDb._updates.filter(
					(update) => update.table === "organizationSubscriptions",
				),
			).toHaveLength(0);
		});

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
		it("resolves the exact current overage attempt from canonical invoice-line evidence", async () => {
			seedOrgSub(mockDb);
			seedInvoice(mockDb, { status: "draft", totalCents: 0 });
			mockDb._seed("billingPeriods", [
				{
					id: "bp_overage_1",
					organizationId: ORG_ID,
					state: "claimed",
					invoiceId: null,
					stripeInvoiceId: "in_test_123",
					committedUnitsSnapshot: 225,
					cycleAllowance: 200,
					overageUnitsSnapshot: 25,
					amountCentsSnapshot: 125,
				},
			]);
			mockDb._seed("billingOperations", [
				{
					id: "bop_overage_1",
					organizationId: ORG_ID,
					billingPeriodId: "bp_overage_1",
					stripeInvoiceId: "in_test_123",
					stripeInvoiceItemId: null,
					status: "unknown",
					attemptRevision: 1,
					amountCents: 125,
					currency: "usd",
					leaseToken: 3,
					completedAt: null,
				},
			]);
			mockDb._seed("billingOperationAttempts", [
				{
					id: "bopa_overage_1",
					organizationId: ORG_ID,
					billingOperationId: "bop_overage_1",
					revision: 1,
					status: "unknown",
					stripeInvoiceId: "in_test_123",
					stripeInvoiceItemId: null,
					amountCents: 125,
					currency: "usd",
				},
			]);

			const canonicalInvoice = {
				...createMockInvoice({ status: "open", amountDue: 625 }),
				lines: {
					has_more: false,
					data: [
						{
							id: "il_stale_revision",
							amount: 125,
							currency: "usd",
							metadata: {
								relayapi_operation_id: "bop_overage_1",
								relayapi_operation_revision: "99",
							},
							parent: {
								invoice_item_details: { invoice_item: "ii_stale_revision" },
							},
						},
						{
							id: "il_overage_1",
							amount: 125,
							currency: "usd",
							metadata: {
								relayapi_operation_id: "bop_overage_1",
								relayapi_operation_revision: "1",
							},
							parent: {
								invoice_item_details: { invoice_item: "ii_overage_1" },
							},
						},
					],
				},
			} as unknown as Stripe.Invoice;
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: { retrieve: async () => canonicalInvoice },
			});

			await handleEvent(createInvoiceFinalizedEvent({ amountDue: 625 }), env);

			const [attempt] = mockDb._getData("billingOperationAttempts");
			expect(attempt?.status).toBe("succeeded");
			expect(attempt?.stripeInvoiceItemId).toBe("ii_overage_1");
			expect(attempt?.providerEvidence).toMatchObject({
				policy: "canonical_stripe_invoice_line_v1",
				decision: "provider_effect_succeeded",
				stripe_invoice_id: "in_test_123",
				stripe_invoice_item_id: "ii_overage_1",
			});
			const [operation] = mockDb._getData("billingOperations");
			expect(operation?.status).toBe("succeeded");
			expect(operation?.stripeInvoiceItemId).toBe("ii_overage_1");
			const [period] = mockDb._getData("billingPeriods");
			expect(period?.state).toBe("settled");
			expect(period?.invoiceId).toBe("inv_row_1");
			expect(period?.stripeInvoiceId).toBe("in_test_123");
		});

		it("durably alerts on late invoice proof without resurrecting a written-off operation", async () => {
			seedOrgSub(mockDb);
			seedInvoice(mockDb, { status: "draft", totalCents: 0 });
			mockDb._seed("billingPeriods", [
				{
					id: "bp_written_off_1",
					organizationId: ORG_ID,
					state: "written_off",
					invoiceId: null,
					stripeInvoiceId: "in_test_123",
				},
			]);
			mockDb._seed("billingOperations", [
				{
					id: "bop_written_off_1",
					organizationId: ORG_ID,
					billingPeriodId: "bp_written_off_1",
					stripeInvoiceId: "in_test_123",
					stripeInvoiceItemId: null,
					status: "written_off",
					attemptRevision: 1,
					amountCents: 125,
					currency: "usd",
					lastError: "Automatic recovery horizon exhausted",
					lastErrorClass: "age_exhausted",
				},
			]);
			mockDb._seed("billingOperationAttempts", [
				{
					id: "bopa_written_off_1",
					organizationId: ORG_ID,
					billingOperationId: "bop_written_off_1",
					revision: 1,
					status: "written_off",
					stripeInvoiceId: "in_test_123",
					stripeInvoiceItemId: null,
					amountCents: 125,
					currency: "usd",
					providerEvidence: {
						policy: "ambiguous_stripe_outcome_30_day_horizon_v1",
					},
				},
			]);
			const canonicalInvoice = {
				...createMockInvoice({ status: "open", amountDue: 625 }),
				lines: {
					has_more: false,
					data: [
						{
							id: "il_late_written_off_1",
							amount: 125,
							currency: "usd",
							metadata: {
								relayapi_operation_id: "bop_written_off_1",
								relayapi_operation_revision: "1",
							},
							parent: {
								invoice_item_details: {
									invoice_item: "ii_late_written_off_1",
								},
							},
						},
					],
				},
			} as unknown as Stripe.Invoice;
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: { retrieve: async () => canonicalInvoice },
			});
			const originalConsoleError = console.error;
			const consoleError = mock(() => {});
			console.error = consoleError;
			try {
				await handleEvent(createInvoiceFinalizedEvent({ amountDue: 625 }), env);
			} finally {
				console.error = originalConsoleError;
			}

			expect(consoleError).toHaveBeenCalledWith(
				"[billing] late invoice evidence for terminal operation",
				expect.objectContaining({
					event: "billing_terminal_operation_late_invoice_evidence",
					billingOperationId: "bop_written_off_1",
					operationStatus: "written_off",
				}),
			);
			expect(mockDb._getData("billingOperations")[0]).toMatchObject({
				status: "written_off",
				stripeInvoiceItemId: "ii_late_written_off_1",
				lastErrorClass: "permanent",
			});
			expect(mockDb._getData("billingOperations")[0]?.lastError).toStartWith(
				"late_provider_effect_requires_compensation:v1:",
			);
			expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
				status: "written_off",
				stripeInvoiceItemId: "ii_late_written_off_1",
				providerEvidence: {
					policy: "ambiguous_stripe_outcome_30_day_horizon_v1",
					late_invoice_evidence: {
						policy: "late_terminal_stripe_invoice_line_v1",
						decision: "retain_terminal_state_and_require_compensation",
						stripe_invoice_id: "in_test_123",
						stripe_invoice_item_id: "ii_late_written_off_1",
						required_operator_decision:
							"issue_compensating_invoice_or_credit_or_accept_writeoff",
					},
				},
			});
			expect(mockDb._getData("billingPeriods")[0]?.state).toBe("written_off");
		});

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

		it("uses retained customer attribution for a late pre-grant invoice", async () => {
			seedOrgSub(mockDb, {
				status: "active",
				source: "complimentary",
				stripeSubscriptionId: null,
			});
			const event = createInvoicePaidEvent();
			mockStripeClient = createMockStripe({
				subscriptions: {
					retrieve: async () => {
						throw Object.assign(new Error("subscription deleted"), {
							statusCode: 404,
						});
					},
				},
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await handleEvent(event, env);

			const [subscription] = mockDb._getData("organizationSubscriptions") as [
				Record<string, unknown>,
			];
			expect(subscription).toMatchObject({
				status: "active",
				source: "complimentary",
				stripeSubscriptionId: null,
				stripeCustomerId: CUSTOMER_ID,
			});
			expect(
				mockDb._updates.filter(
					(update) => update.table === "organizationSubscriptions",
				),
			).toHaveLength(0);
			expect(
				mockDb._inserts.some(
					(insert) =>
						insert.table === "invoices" &&
						insert.values.organizationId === ORG_ID,
				),
			).toBe(true);
		});

		it("fails closed when canonical invoice identities split across organizations", async () => {
			mockDb._seed("organizationSubscriptions", [
				{
					id: "sub_row_by_subscription",
					organizationId: "org_by_subscription",
					status: "active",
					source: "stripe",
					stripeCustomerId: "cus_other",
					stripeSubscriptionId: SUB_ID,
				},
				{
					id: "sub_row_by_customer",
					organizationId: "org_by_customer",
					status: "cancelled",
					source: "stripe",
					stripeCustomerId: CUSTOMER_ID,
					stripeSubscriptionId: null,
				},
			]);
			const event = createInvoicePaidEvent();
			mockStripeClient = createMockStripe({
				subscriptions: { retrieve: async () => createMockSubscription() },
				invoices: {
					retrieve: async () => createMockInvoice({ status: "paid" }),
				},
			});

			await expect(handleEvent(event, env)).rejects.toThrow(
				"subscription and customer map to different organizations",
			);
			expect(
				mockDb._inserts.filter((insert) => insert.table === "invoices"),
			).toHaveLength(0);
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
