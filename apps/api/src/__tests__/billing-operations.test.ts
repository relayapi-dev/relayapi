import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockDb, type MockDb } from "./__mocks__/db";
import { createMockEnv } from "./__mocks__/env";

const billingOperations = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	usageBucketSettlementId: { name: "usageBucketSettlementId" },
	status: { name: "status" },
	attempts: { name: "attempts" },
	leaseToken: { name: "leaseToken" },
	nextAttemptAt: { name: "nextAttemptAt" },
	leaseExpiresAt: { name: "leaseExpiresAt" },
	createdAt: { name: "createdAt" },
	updatedAt: { name: "updatedAt" },
	toString: () => "billing_operations",
};

mock.module("@relayapi/db", () => ({
	billingOperations,
	createDb: () => mockDb,
}));

type Condition = { _filter?: (row: Record<string, unknown>) => boolean };
mock.module("drizzle-orm", () => ({
	eq: (col: { name: string }, value: unknown): Condition => ({
		_filter: (row) => row[col.name] === value,
	}),
	inArray: (col: { name: string }, values: unknown[]): Condition => ({
		_filter: (row) => values.includes(row[col.name]),
	}),
	lte: (col: { name: string }, value: Date): Condition => ({
		_filter: (row) => !row[col.name] || (row[col.name] as Date) <= value,
	}),
	and: (...conditions: Condition[]): Condition => ({
		_filter: (row) => conditions.every((c) => c._filter?.(row) ?? true),
	}),
	or: (...conditions: Condition[]): Condition => ({
		_filter: (row) => conditions.some((c) => c._filter?.(row) ?? false),
	}),
	asc: (value: unknown) => value,
	sql: (_strings: TemplateStringsArray, ..._values: unknown[]) => 1,
}));

mock.module("../services/stripe", () => ({
	createStripeClient: async () => {
		throw new Error("test must inject Stripe client");
	},
}));

const { processOverageBillingOperations } = await import(
	"../services/billing-operations"
);

let mockDb: MockDb;

function seedOperation(status: string) {
	const now = new Date("2026-07-12T12:00:00.000Z");
	mockDb._seed("billingOperations", [
		{
			id: "bop_ubs_1",
			organizationId: "org_1",
			usageBucketSettlementId: "ubs_1",
			status,
			stripeCustomerId: "cus_1",
			stripeInvoiceItemId: null,
			idempotencyKey: "relayapi:overage:usage-bucket:ub_1",
			amountCents: 125,
			currency: "usd",
			description: "API overage",
			attempts: status === "unknown" ? 1 : 0,
			leaseToken: 0,
			nextAttemptAt: new Date("2026-07-12T11:00:00.000Z"),
			leaseExpiresAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		},
	]);
}

beforeEach(() => {
	mockDb = createMockDb();
});

describe("durable overage billing operations", () => {
	it("creates with a stable idempotency key and persists the Stripe item ID", async () => {
		seedOperation("pending");
		const createCalls: Array<{
			params: Record<string, unknown>;
			key?: string;
		}> = [];
		const stripe = {
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async (
					params: Record<string, unknown>,
					opts?: { idempotencyKey?: string },
				) => {
					createCalls.push({ params, key: opts?.idempotencyKey });
					return { id: "ii_created" };
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(createCalls).toHaveLength(1);
		const createCall = createCalls[0];
		if (!createCall) throw new Error("expected Stripe invoice-item create");
		expect(createCall.key).toBe("relayapi:overage:usage-bucket:ub_1");
		expect(
			(createCall.params.metadata as Record<string, string>)
				.relayapi_operation_id,
		).toBe("bop_ubs_1");
		expect(
			(createCall.params.metadata as Record<string, string>)
				.usage_bucket_settlement_id,
		).toBe("ubs_1");
		expect(mockDb._getData("billingOperations")[0]?.stripeInvoiceItemId).toBe(
			"ii_created",
		);
		expect(mockDb._getData("billingOperations")[0]?.status).toBe("succeeded");
		expect(mockDb._getData("billingOperations")[0]?.completedAt).toBeInstanceOf(
			Date,
		);
	});

	it("reconciles an unknown outcome by metadata before retrying", async () => {
		seedOperation("unknown");
		let creates = 0;
		const stripe = {
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						yield {
							id: "ii_reconciled",
							metadata: { relayapi_operation_id: "bop_ubs_1" },
						};
					},
				}),
				create: async () => {
					creates++;
					return { id: "ii_duplicate" };
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toBe(0);
		expect(mockDb._getData("billingOperations")[0]?.stripeInvoiceItemId).toBe(
			"ii_reconciled",
		);
		expect(mockDb._getData("billingOperations")[0]?.status).toBe("succeeded");
		expect(mockDb._getData("billingOperations")[0]?.completedAt).toBeInstanceOf(
			Date,
		);
	});

	it("rejects a stale worker's terminal write after its lease is superseded", async () => {
		seedOperation("pending");
		const stripe = {
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async () => {
					const row = mockDb._getData("billingOperations")[0];
					if (row) {
						mockDb._seed("billingOperations", [{ ...row, leaseToken: 99 }]);
					}
					return { id: "ii_stale_worker" };
				},
			},
		};

		const completed = await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(completed).toBe(0);
		expect(
			mockDb._getData("billingOperations")[0]?.stripeInvoiceItemId,
		).toBeNull();
		expect(mockDb._getData("billingOperations")[0]?.completedAt).toBeNull();
	});
});
