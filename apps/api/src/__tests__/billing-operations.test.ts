import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createMockDb, type MockDb } from "./__mocks__/db";
import { createMockEnv } from "./__mocks__/env";

const billingOperations = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	billingPeriodId: { name: "billingPeriodId" },
	kind: { name: "kind" },
	status: { name: "status" },
	stripeInvoiceId: { name: "stripeInvoiceId" },
	stripeInvoiceItemId: { name: "stripeInvoiceItemId" },
	stripeSubscriptionId: { name: "stripeSubscriptionId" },
	invoiceIdempotencyKey: { name: "invoiceIdempotencyKey" },
	attemptRevision: { name: "attemptRevision" },
	attempts: { name: "attempts" },
	leaseToken: { name: "leaseToken" },
	nextAttemptAt: { name: "nextAttemptAt" },
	leaseExpiresAt: { name: "leaseExpiresAt" },
	lastError: { name: "lastError" },
	lastErrorClass: { name: "lastErrorClass" },
	operatorRetryRequestedAt: { name: "operatorRetryRequestedAt" },
	createdAt: { name: "createdAt" },
	updatedAt: { name: "updatedAt" },
	completedAt: { name: "completedAt" },
	toString: () => "billing_operations",
};

const billingOperationAttempts = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	billingOperationId: { name: "billingOperationId" },
	revision: { name: "revision" },
	status: { name: "status" },
	requestMayHaveBeenSentAt: { name: "requestMayHaveBeenSentAt" },
	toString: () => "billingOperationAttempts",
};

const billingPeriods = {
	id: { name: "id" },
	organizationId: { name: "organizationId" },
	state: { name: "state" },
	toString: () => "billingPeriods",
};

mock.module("@relayapi/db", () => ({
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
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
	isNull: (col: { name: string }): Condition => ({
		_filter: (row) => row[col.name] == null,
	}),
	isNotNull: (col: { name: string }): Condition => ({
		_filter: (row) => row[col.name] != null,
	}),
	and: (...conditions: Condition[]): Condition => ({
		_filter: (row) => conditions.every((c) => c._filter?.(row) ?? true),
	}),
	or: (...conditions: Condition[]): Condition => ({
		_filter: (row) => conditions.some((c) => c._filter?.(row) ?? false),
	}),
	asc: (value: unknown) => value,
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
		const operator = strings.join("").trim();
		const column = values[0] as { name?: string } | undefined;
		const expected = values[1];
		if (
			column?.name &&
			(operator === ">=" || operator === ">" || operator === "<")
		) {
			return {
				_filter: (row: Record<string, unknown>) => {
					const actual = row[column.name ?? ""];
					const left = actual instanceof Date ? actual.getTime() : actual;
					const right =
						expected instanceof Date ? expected.getTime() : expected;
					if (operator === ">=") return Number(left) >= Number(right);
					if (operator === ">") return Number(left) > Number(right);
					return Number(left) < Number(right);
				},
			};
		}
		return 1;
	},
}));

mock.module("../services/stripe", () => ({
	createStripeClient: async () => {
		throw new Error("test must inject Stripe client");
	},
}));

const organizationFenceEvents: string[] = [];
mock.module("../services/stripe-organization-lease", () => ({
	assertStripeOrganizationFence: async () => {
		organizationFenceEvents.push("fence");
	},
}));

const {
	BILLING_OPERATION_MAX_AGE_MS,
	BILLING_OPERATION_MAX_ATTEMPTS,
	billingOperationNeedsManualReview,
	processCatchupInvoiceOperations,
	processExactOverageBillingOperation,
	processOverageBillingOperations,
} = await import("../services/billing-operations");

let mockDb: MockDb;

function seedOperation(status: string) {
	const now = new Date(Date.now() - 60_000);
	mockDb._seed("billingOperations", [
		{
			id: "bop_ubs_1",
			organizationId: "org_1",
			billingPeriodId: "bp_1",
			kind: "cycle",
			status,
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_1",
			stripeInvoiceId: "in_1",
			stripeInvoiceItemId: null,
			invoiceIdempotencyKey: null,
			idempotencyKey: "relayapi:overage:bp_1:cycle:r1",
			attemptRevision: 1,
			amountCents: 125,
			currency: "usd",
			description: "API overage",
			attempts: status === "unknown" ? 1 : 0,
			leaseToken: 0,
			nextAttemptAt: new Date(now.getTime() - 60_000),
			leaseExpiresAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		},
	]);
	mockDb._seed("billingOperationAttempts", [
		{
			id: "boa_1",
			organizationId: "org_1",
			billingOperationId: "bop_ubs_1",
			revision: 1,
			status: status === "unknown" ? "unknown" : "prepared",
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_1",
			stripeInvoiceId: "in_1",
			stripeInvoiceItemId: null,
			idempotencyKey: "relayapi:overage:bp_1:cycle:r1",
			amountCents: 125,
			currency: "usd",
			description: "API overage",
			requestMayHaveBeenSentAt:
				status === "unknown" ? new Date(now.getTime() - 30_000) : null,
			providerEvidence: null,
			createdAt: now,
			resolvedAt: null,
		},
	]);
	mockDb._seed("billingPeriods", [
		{
			id: "bp_1",
			organizationId: "org_1",
			stripeCustomerId: "cus_1",
			stripeSubscriptionId: "sub_1",
			periodStart: new Date("2026-06-01T00:00:00.000Z"),
			periodEnd: new Date("2026-07-01T00:00:00.000Z"),
			discountable: false,
			taxBehavior: "exclusive",
			taxCode: "txcd_test",
		},
	]);
}

beforeEach(() => {
	mockDb = createMockDb();
	organizationFenceEvents.length = 0;
});

describe("durable overage billing operations", () => {
	it("escalates after either the attempt or age recovery bound", () => {
		const now = new Date("2026-07-28T12:00:00.000Z");
		expect(
			billingOperationNeedsManualReview(
				{ attempts: BILLING_OPERATION_MAX_ATTEMPTS, createdAt: now },
				now,
			),
		).toBe("retry_exhausted");
		expect(
			billingOperationNeedsManualReview(
				{
					attempts: 1,
					createdAt: new Date(now.getTime() - BILLING_OPERATION_MAX_AGE_MS),
				},
				now,
			),
		).toBe("age_exhausted");
		expect(
			billingOperationNeedsManualReview(
				{ attempts: 1, createdAt: new Date(now.getTime() - 1_000) },
				now,
			),
		).toBeNull();
	});

	it("audits and writes off an ambiguous operation after 30 days", async () => {
		seedOperation("unknown");
		const agedAt = new Date(Date.now() - BILLING_OPERATION_MAX_AGE_MS - 60_000);
		const operation = mockDb._getData("billingOperations")[0];
		const attempt = mockDb._getData("billingOperationAttempts")[0];
		const period = mockDb._getData("billingPeriods")[0];
		if (!operation || !attempt || !period)
			throw new Error("missing billing seed");
		mockDb._seed("billingOperations", [
			{ ...operation, createdAt: agedAt, updatedAt: agedAt },
		]);
		mockDb._seed("billingOperationAttempts", [
			{ ...attempt, createdAt: agedAt },
		]);
		mockDb._seed("billingPeriods", [
			{
				...period,
				state: "claimed",
				committedUnitsSnapshot: 11_250,
				overageUnitsSnapshot: 1_250,
				amountCentsSnapshot: 125,
			},
		]);

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			{} as never,
		);

		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "written_off",
			lastErrorClass: "age_exhausted",
		});
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			status: "written_off",
		});
		expect(mockDb._getData("billingPeriods")[0]).toMatchObject({
			state: "written_off",
			writeOffReason:
				"automatic_ambiguous_stripe_outcome_recovery_horizon_exhausted",
		});
		expect(
			(
				mockDb._getData("billingPeriods")[0]?.writeOffEvidence as {
					policy?: string;
				}
			)?.policy,
		).toBe("ambiguous_stripe_outcome_30_day_horizon_v1");
	});

	it("creates with a stable idempotency key and persists the Stripe item ID", async () => {
		seedOperation("pending");
		const createCalls: Array<{
			params: Record<string, unknown>;
			key?: string;
		}> = [];
		const stripe = {
			invoices: {
				retrieve: async () => ({
					id: "in_1",
					status: "draft",
					customer: "cus_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async (
					params: Record<string, unknown>,
					opts?: { idempotencyKey?: string },
				) => {
					createCalls.push({ params, key: opts?.idempotencyKey });
					return {
						id: "ii_created",
						invoice: "in_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
					};
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
		expect(createCall.key).toBe("relayapi:overage:bp_1:cycle:r1");
		expect(createCall.params.invoice).toBe("in_1");
		expect(createCall.params.subscription).toBe("sub_1");
		expect(
			(createCall.params.metadata as Record<string, string>)
				.relayapi_operation_id,
		).toBe("bop_ubs_1");
		expect(
			(createCall.params.metadata as Record<string, string>).billing_period_id,
		).toBe("bp_1");
		expect(
			(createCall.params.metadata as Record<string, string>)
				.relayapi_operation_revision,
		).toBe("1");
		expect(mockDb._getData("billingOperations")[0]?.stripeInvoiceItemId).toBe(
			"ii_created",
		);
		expect(mockDb._getData("billingOperations")[0]?.status).toBe("succeeded");
		expect(mockDb._getData("billingOperationAttempts")[0]?.status).toBe(
			"succeeded",
		);
		expect(mockDb._getData("billingOperations")[0]?.completedAt).toBeInstanceOf(
			Date,
		);
	});

	it("processes only the fenced invoice-created operation", async () => {
		seedOperation("pending");
		const targetOperation = mockDb._getData("billingOperations")[0];
		const targetAttempt = mockDb._getData("billingOperationAttempts")[0];
		const targetPeriod = mockDb._getData("billingPeriods")[0];
		if (!targetOperation || !targetAttempt || !targetPeriod) {
			throw new Error("missing billing seed");
		}
		const older = new Date(
			(targetOperation.createdAt as Date).getTime() - 60_000,
		);
		mockDb._seed("billingOperations", [
			{
				...targetOperation,
				id: "bop_other",
				organizationId: "org_other",
				billingPeriodId: "bp_other",
				stripeCustomerId: "cus_other",
				stripeSubscriptionId: "sub_other",
				stripeInvoiceId: "in_other",
				idempotencyKey: "relayapi:overage:bp_other:cycle:r1",
				createdAt: older,
				nextAttemptAt: older,
			},
			targetOperation,
		]);
		mockDb._seed("billingOperationAttempts", [
			{
				...targetAttempt,
				id: "boa_other",
				organizationId: "org_other",
				billingOperationId: "bop_other",
				stripeCustomerId: "cus_other",
				stripeSubscriptionId: "sub_other",
				stripeInvoiceId: "in_other",
				idempotencyKey: "relayapi:overage:bp_other:cycle:r1",
			},
			targetAttempt,
		]);
		mockDb._seed("billingPeriods", [
			{
				...targetPeriod,
				id: "bp_other",
				organizationId: "org_other",
				stripeCustomerId: "cus_other",
				stripeSubscriptionId: "sub_other",
			},
			targetPeriod,
		]);

		const providerEvents = organizationFenceEvents;
		const stripe = {
			invoices: {
				retrieve: async () => {
					providerEvents.push("stripe:invoice.retrieve");
					return {
						id: "in_1",
						status: "draft",
						customer: "cus_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
					};
				},
			},
			invoiceItems: {
				list: () => {
					providerEvents.push("stripe:invoiceItem.list");
					return {
						async *[Symbol.asyncIterator]() {},
					};
				},
				create: async () => {
					providerEvents.push("stripe:invoiceItem.create");
					return {
						id: "ii_exact",
						invoice: "in_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
					};
				},
			},
		};

		const completed = await processExactOverageBillingOperation(
			createMockEnv().env,
			{
				operationId: "bop_ubs_1",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				organizationFence: {
					organizationId: "org_1",
					ownerId: "evt_invoice_created",
					leaseToken: 7,
				},
			},
			mockDb as never,
			stripe as never,
		);

		expect(completed).toBe(1);
		expect(
			mockDb
				._getData("billingOperations")
				.find((operation) => operation.id === "bop_other"),
		).toMatchObject({ status: "pending", attempts: 0, leaseToken: 0 });
		expect(
			mockDb
				._getData("billingOperationAttempts")
				.find((attempt) => attempt.id === "boa_other"),
		).toMatchObject({ status: "prepared" });
		expect(
			mockDb
				._getData("billingOperations")
				.find((operation) => operation.id === "bop_ubs_1"),
		).toMatchObject({ status: "succeeded", stripeInvoiceItemId: "ii_exact" });
		for (const [index, event] of providerEvents.entries()) {
			if (event.startsWith("stripe:")) {
				expect(providerEvents[index - 1]).toBe("fence");
			}
		}
		// One post-mutation heartbeat guards catch-up finalization and the next
		// transaction-owned heartbeat guards the final financial projection.
		expect(providerEvents.slice(-2)).toEqual(["fence", "fence"]);
	});

	it("rejects an exact operation scope that disagrees with its organization fence", async () => {
		seedOperation("pending");
		let providerCalls = 0;

		await expect(
			processExactOverageBillingOperation(
				createMockEnv().env,
				{
					operationId: "bop_ubs_1",
					organizationId: "org_1",
					billingPeriodId: "bp_1",
					organizationFence: {
						organizationId: "org_other",
						ownerId: "evt_wrong_org",
						leaseToken: 1,
					},
				},
				mockDb as never,
				{
					invoiceItems: {
						list: () => {
							providerCalls++;
							return { async *[Symbol.asyncIterator]() {} };
						},
					},
				} as never,
			),
		).rejects.toThrow(
			"Exact billing-operation scope disagrees with its organization fence",
		);

		expect(providerCalls).toBe(0);
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "pending",
			attempts: 0,
			leaseToken: 0,
		});
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
							invoice: "in_1",
							parent: {
								subscription_details: { subscription: "sub_1" },
							},
							metadata: {
								relayapi_operation_id: "bop_ubs_1",
								relayapi_operation_revision: "1",
							},
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

	it("revises a provably unsent cycle item into catch-up when the invoice closes", async () => {
		seedOperation("pending");
		let creates = 0;
		const stripe = {
			invoices: {
				retrieve: async () => ({
					id: "in_1",
					status: "open",
					customer: "cus_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async () => {
					creates++;
					return { id: "ii_must_not_be_created" };
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toBe(0);
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			status: "rejected",
			providerEvidence: {
				policy: "canonical_closed_invoice_before_request_v1",
				decision: "provider_effect_not_applied",
				stripe_invoice_status: "open",
			},
		});
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			kind: "catchup",
			status: "invoice_preparing",
			stripeInvoiceId: null,
			attemptRevision: 2,
			attempts: 0,
			invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice:r2",
			idempotencyKey: "relayapi:overage:bp_1:catchup:r2",
		});
	});

	it("revises a staged item after exact absence and a closed invoice are recovered", async () => {
		seedOperation("pending");
		const attempt = mockDb._getData("billingOperationAttempts")[0];
		if (!attempt) throw new Error("missing billing attempt seed");
		mockDb._seed("billingOperationAttempts", [
			{
				...attempt,
				status: "requesting",
				requestMayHaveBeenSentAt: new Date(Date.now() - 60_000),
			},
		]);
		let creates = 0;
		const stripe = {
			invoices: {
				retrieve: async () => ({
					id: "in_1",
					status: "open",
					customer: "cus_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						yield* [];
					},
				}),
				create: async () => {
					creates++;
					return { id: "ii_must_not_be_created" };
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toBe(0);
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			status: "rejected",
			providerEvidence: {
				policy: "canonical_closed_invoice_rejected_request_absent_v1",
				decision: "provider_effect_not_applied",
			},
		});
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			kind: "catchup",
			status: "invoice_preparing",
			attemptRevision: 2,
			attempts: 0,
		});
	});

	it("reconciles an absent rejected item and rotates when the invoice closes during create", async () => {
		seedOperation("pending");
		let invoiceReads = 0;
		let itemLists = 0;
		const stripe = {
			invoices: {
				retrieve: async () => {
					invoiceReads++;
					return {
						id: "in_1",
						status: invoiceReads === 1 ? "draft" : "open",
						customer: "cus_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
					};
				},
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						itemLists++;
						yield* [];
					},
				}),
				create: async () => {
					throw Object.assign(new Error("Invoice is no longer editable"), {
						statusCode: 400,
					});
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(itemLists).toBe(2);
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			status: "rejected",
			providerEvidence: {
				policy: "canonical_closed_invoice_rejected_request_absent_v1",
				decision: "provider_effect_not_applied",
				stripe_invoice_status: "open",
			},
		});
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			kind: "catchup",
			status: "invoice_preparing",
			attemptRevision: 2,
			attempts: 0,
		});
	});

	it("parks an unreconcilable prior outcome instead of declaring it failed", async () => {
		seedOperation("unknown");
		let creates = 0;
		const reconciliationError = Object.assign(
			new Error("Stripe credentials rejected"),
			{ statusCode: 401 },
		);
		const stripe = {
			invoices: {
				retrieve: async () => ({
					id: "in_1",
					status: "draft",
					customer: "cus_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						yield await Promise.reject(reconciliationError);
					},
				}),
				create: async () => {
					creates++;
					return { id: "ii_should_not_be_created" };
				},
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toBe(0);
		expect(mockDb._getData("billingOperations")[0]?.status).toBe(
			"manual_review",
		);
		expect(mockDb._getData("billingOperations")[0]?.lastErrorClass).toBe(
			"permanent",
		);
		expect(mockDb._getData("billingOperations")[0]?.completedAt).toBeInstanceOf(
			Date,
		);
	});

	it("rejects a stale worker's terminal write after its lease is superseded", async () => {
		seedOperation("pending");
		const stripe = {
			invoices: {
				retrieve: async () => ({
					id: "in_1",
					status: "draft",
					customer: "cus_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async () => {
					const row = mockDb._getData("billingOperations")[0];
					if (row) {
						mockDb._seed("billingOperations", [{ ...row, leaseToken: 99 }]);
					}
					return {
						id: "ii_stale_worker",
						invoice: "in_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
					};
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

	it("creates a standalone catch-up invoice with no pending-item sweep", async () => {
		const now = new Date(Date.now() - 60_000);
		mockDb._seed("billingOperations", [
			{
				id: "bop_bp_1_catchup",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				kind: "catchup",
				status: "invoice_preparing",
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
				stripeInvoiceId: null,
				stripeInvoiceItemId: null,
				invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice",
				idempotencyKey: "relayapi:overage:bp_1:catchup:r1",
				attemptRevision: 1,
				amountCents: 125,
				currency: "usd",
				description: "API overage",
				attempts: 0,
				leaseToken: 0,
				nextAttemptAt: new Date(now.getTime() - 1_000),
				leaseExpiresAt: null,
				lastError: null,
				createdAt: now,
				updatedAt: now,
				completedAt: null,
			},
		]);
		const creates: Array<{
			params: Record<string, unknown>;
			key?: string;
		}> = [];
		const stripe = {
			invoices: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async (
					params: Record<string, unknown>,
					options?: { idempotencyKey?: string },
				) => {
					creates.push({ params, key: options?.idempotencyKey });
					return {
						id: "in_catchup",
						status: "draft",
						customer: "cus_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
						metadata: {
							relayapi_operation_id: "bop_bp_1_catchup",
							relayapi_operation_kind: "catchup",
							relayapi_operation_revision: "1",
							billing_period_id: "bp_1",
							organization_id: "org_1",
						},
					};
				},
			},
		};

		await processCatchupInvoiceOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toHaveLength(1);
		expect(creates[0]?.key).toBe("relayapi:overage:bp_1:catchup-invoice");
		expect(creates[0]?.params).toMatchObject({
			customer: "cus_1",
			subscription: "sub_1",
			auto_advance: false,
			pending_invoice_items_behavior: "exclude",
			metadata: { relayapi_operation_revision: "1" },
		});
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "pending",
			stripeInvoiceId: "in_catchup",
		});
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			billingOperationId: "bop_bp_1_catchup",
			stripeInvoiceId: "in_catchup",
			status: "prepared",
		});
	});

	it("ignores an older catch-up invoice revision during operator-directed rebilling", async () => {
		const now = new Date(Date.now() - BILLING_OPERATION_MAX_AGE_MS - 60_000);
		mockDb._seed("billingOperations", [
			{
				id: "bop_bp_1_catchup",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				kind: "catchup",
				status: "invoice_unknown",
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
				stripeInvoiceId: null,
				stripeInvoiceItemId: null,
				invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice:r2",
				idempotencyKey: "relayapi:overage:bp_1:catchup:r2",
				attemptRevision: 2,
				amountCents: 125,
				currency: "usd",
				description: "API overage",
				attempts: 0,
				leaseToken: 1,
				nextAttemptAt: new Date(now.getTime() - 1_000),
				leaseExpiresAt: null,
				lastError: null,
				createdAt: now,
				updatedAt: now,
				completedAt: null,
			},
		]);
		mockDb._seed("billingPeriods", [
			{
				id: "bp_1",
				organizationId: "org_1",
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
				periodStart: new Date("2026-06-01T00:00:00.000Z"),
				periodEnd: new Date("2026-07-01T00:00:00.000Z"),
				discountable: false,
				taxBehavior: "exclusive",
				taxCode: "txcd_test",
			},
		]);
		let creates = 0;
		const invoice = (id: string, revision: string) => ({
			id,
			status: "draft",
			customer: "cus_1",
			parent: { subscription_details: { subscription: "sub_1" } },
			metadata: {
				relayapi_operation_id: "bop_bp_1_catchup",
				relayapi_operation_kind: "catchup",
				relayapi_operation_revision: revision,
				billing_period_id: "bp_1",
				organization_id: "org_1",
			},
		});
		const stripe = {
			invoices: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						yield invoice("in_old_revision", "1");
						yield invoice("in_current_revision", "2");
					},
				}),
				create: async () => {
					creates++;
					return invoice("in_duplicate", "2");
				},
				retrieve: async () => invoice("in_current_revision", "2"),
				finalizeInvoice: async () => ({
					...invoice("in_current_revision", "2"),
					status: "open",
				}),
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {
						yield* [];
					},
				}),
				create: async () => ({
					id: "ii_current_revision",
					invoice: "in_current_revision",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
		};

		await processCatchupInvoiceOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(creates).toBe(0);
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "pending",
			stripeInvoiceId: "in_current_revision",
			attemptRevision: 2,
			attempts: 0,
		});
		expect(mockDb._getData("billingOperationAttempts")[0]).toMatchObject({
			revision: 2,
			stripeInvoiceId: "in_current_revision",
		});

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "succeeded",
			stripeInvoiceItemId: "ii_current_revision",
		});
	});

	it("leases catch-up invoice creation across overlapping recovery workers", async () => {
		const now = new Date(Date.now() - 60_000);
		mockDb._seed("billingOperations", [
			{
				id: "bop_bp_1_catchup",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				kind: "catchup",
				status: "invoice_unknown",
				stripeCustomerId: "cus_1",
				stripeSubscriptionId: "sub_1",
				stripeInvoiceId: null,
				stripeInvoiceItemId: null,
				invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice",
				idempotencyKey: "relayapi:overage:bp_1:catchup:r1",
				attemptRevision: 1,
				amountCents: 125,
				currency: "usd",
				description: "API overage",
				attempts: 1,
				leaseToken: 1,
				nextAttemptAt: new Date(now.getTime() - 1_000),
				leaseExpiresAt: null,
				lastError: null,
				createdAt: now,
				updatedAt: now,
				completedAt: null,
			},
		]);
		let creates = 0;
		const stripe = {
			invoices: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async () => {
					creates++;
					await Promise.resolve();
					return {
						id: "in_catchup",
						status: "draft",
						customer: "cus_1",
						parent: {
							subscription_details: { subscription: "sub_1" },
						},
						metadata: {
							relayapi_operation_id: "bop_bp_1_catchup",
							relayapi_operation_kind: "catchup",
							relayapi_operation_revision: "1",
							billing_period_id: "bp_1",
							organization_id: "org_1",
						},
					};
				},
			},
		};

		await Promise.all([
			processCatchupInvoiceOperations(
				createMockEnv().env,
				mockDb as never,
				stripe as never,
			),
			processCatchupInvoiceOperations(
				createMockEnv().env,
				mockDb as never,
				stripe as never,
			),
		]);

		expect(creates).toBe(1);
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "pending",
			stripeInvoiceId: "in_catchup",
			leaseExpiresAt: null,
		});
	});

	it("attaches the catch-up item exactly and finalizes only after verification", async () => {
		seedOperation("pending");
		const operation = mockDb._getData("billingOperations")[0];
		if (!operation) throw new Error("missing seeded operation");
		mockDb._seed("billingOperations", [
			{
				...operation,
				kind: "catchup",
				invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice",
				idempotencyKey: "relayapi:overage:bp_1:catchup:r1",
			},
		]);
		const attempt = mockDb._getData("billingOperationAttempts")[0];
		if (!attempt) throw new Error("missing seeded attempt");
		mockDb._seed("billingOperationAttempts", [
			{
				...attempt,
				idempotencyKey: "relayapi:overage:bp_1:catchup:r1",
			},
		]);
		const finalized: Array<{ id: string; key?: string }> = [];
		const invoice = (status: "draft" | "open") => ({
			id: "in_1",
			status,
			customer: "cus_1",
			parent: { subscription_details: { subscription: "sub_1" } },
			metadata: {
				relayapi_operation_id: "bop_ubs_1",
				relayapi_operation_kind: "catchup",
				relayapi_operation_revision: "1",
				billing_period_id: "bp_1",
				organization_id: "org_1",
			},
		});
		const stripe = {
			invoices: {
				retrieve: async () => invoice("draft"),
				finalizeInvoice: async (
					id: string,
					_params: unknown,
					options?: { idempotencyKey?: string },
				) => {
					finalized.push({ id, key: options?.idempotencyKey });
					return invoice("open");
				},
			},
			invoiceItems: {
				list: () => ({
					async *[Symbol.asyncIterator]() {},
				}),
				create: async () => ({
					id: "ii_catchup",
					invoice: "in_1",
					parent: {
						subscription_details: { subscription: "sub_1" },
					},
				}),
			},
		};

		await processOverageBillingOperations(
			createMockEnv().env,
			mockDb as never,
			stripe as never,
		);

		expect(finalized).toEqual([
			{
				id: "in_1",
				key: "relayapi:overage:bp_1:catchup:r1:finalize",
			},
		]);
		expect(mockDb._getData("billingOperations")[0]).toMatchObject({
			status: "succeeded",
			stripeInvoiceItemId: "ii_catchup",
		});
	});
});
