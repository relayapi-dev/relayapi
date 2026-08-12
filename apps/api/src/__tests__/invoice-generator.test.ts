import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { createMockDb, type MockDb, mockEq } from "./__mocks__/db";

const col = (name: string) => ({ name });
const table = (name: string, columns: string[]) => ({
	...Object.fromEntries(columns.map((column) => [column, col(column)])),
	toString: () => name,
});

const apikey = table("apikey", ["organizationId", "key"]);
const adCreationOperations = table("adCreationOperations", [
	"usageReservationId",
	"organizationId",
]);
const adMutationOperations = table("adMutationOperations", [
	"usageReservationId",
	"organizationId",
]);
const billingOperationAttempts = table("billingOperationAttempts", [
	"id",
	"billingOperationId",
	"organizationId",
	"revision",
	"status",
]);
const billingOperations = table("billing_operations", [
	"id",
	"billingPeriodId",
	"organizationId",
	"kind",
	"status",
	"leaseToken",
]);
const billingPeriods = table("billingPeriods", [
	"id",
	"organizationId",
	"state",
	"releaseCount",
	"source",
	"billable",
	"periodEnd",
	"stripeCustomerId",
	"stripeSubscriptionId",
	"stripePriceId",
]);
const organizationSubscriptions = table("organizationSubscriptions", [
	"id",
	"organizationId",
	"status",
]);
const toolJobs = table("toolJobs", [
	"usageReservationId",
	"organizationId",
	"status",
]);
const usageBuckets = table("usageBuckets", [
	"id",
	"organizationId",
	"billingPeriodId",
	"metric",
]);
const usageReservationCarryovers = table("usageReservationCarryovers", [
	"sourceReservationId",
	"organizationId",
	"successorBucketId",
]);
const usageReservations = table("usageReservations", [
	"id",
	"organizationId",
	"bucketId",
	"state",
	"reservedAt",
	"requestMayHaveBeenSentAt",
	"committedUnits",
]);
const whatsappPhoneProvisioningOperations = table(
	"whatsappPhoneProvisioningOperations",
	["provisioningUsageReservationId", "organizationId"],
);
const whatsappPhoneReleaseOperations = table("whatsappPhoneReleaseOperations", [
	"releaseUsageReservationId",
	"organizationId",
]);
const stripeOrganizationLeases = table("stripeOrganizationLeases", [
	"organizationId",
	"ownerEventId",
	"leaseToken",
	"leaseExpiresAt",
]);

let mockDb: MockDb;
mock.module("@relayapi/db", () => ({
	adCreationOperations,
	adMutationOperations,
	apikey,
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
	createDb: () => mockDb,
	organizationSubscriptions,
	stripeOrganizationLeases,
	toolJobs,
	usageBuckets,
	usageReservationCarryovers,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
}));

type Condition = { _filter?: (row: Record<string, unknown>) => boolean };
mock.module("drizzle-orm", () => ({
	eq: (column: unknown, value: unknown) => mockEq(column, value),
	inArray: (column: { name: string }, values: unknown[]): Condition => ({
		_filter: (row) => values.includes(row[column.name]),
	}),
	and: (...conditions: Condition[]): Condition => ({
		_filter: (row) =>
			conditions.every((condition) => condition._filter?.(row) ?? true),
	}),
	gt: (column: { name: string }, value: unknown): Condition => ({
		_filter: (row) => (row[column.name] as never) > (value as never),
	}),
	lt: (column: { name: string }, value: unknown): Condition => ({
		_filter: (row) => (row[column.name] as never) < (value as never),
	}),
	lte: (column: { name: string }, value: unknown): Condition => ({
		_filter: (row) => (row[column.name] as never) <= (value as never),
	}),
	or: (...conditions: Condition[]): Condition => ({
		_filter: (row) =>
			conditions.some((condition) => condition._filter?.(row) ?? false),
	}),
	isNull: (column: { name: string }): Condition => ({
		_filter: (row) => row[column.name] == null,
	}),
	isNotNull: (column: { name: string }): Condition => ({
		_filter: (row) => row[column.name] != null,
	}),
	asc: (value: unknown) => value,
	sql: () => 1,
}));

const {
	claimBillingPeriod,
	findExactDraftInvoiceForBillingPeriod,
	invoiceDiscoveryFallbackOffset,
	invoiceLineMatchesBillingPeriod,
	parseInvoiceDiscoveryCursor,
} = await import("../services/invoice-generator");

const period = {
	id: "bp_1",
	organizationId: "org_1",
	source: "stripe",
	billable: true,
	quotaMode: "metered",
	providerCycleAnchor: new Date("2026-06-01T00:00:00.000Z"),
	periodStart: new Date("2026-06-01T00:00:00.000Z"),
	periodEnd: new Date("2026-07-01T00:00:00.000Z"),
	stripeCustomerId: "cus_base",
	stripeSubscriptionId: "sub_base",
	stripeProductId: "prod_base",
	stripePriceId: "price_base",
	stripePriceRole: "base",
	rateCardVersion: "hosted-usd-v1",
	taxBehavior: "exclusive",
	taxCode: "txcd_test",
	discountable: false,
	cycleAllowance: 10_000,
	includedUnits: 10_000,
	pricePerThousandUnitsCents: 100,
	basePriceCents: 500,
	currency: "usd",
	state: "open",
	committedUnitsSnapshot: null,
	effectiveIncludedUnitsSnapshot: null,
	overageUnitsSnapshot: null,
	amountCentsSnapshot: null,
	invoiceId: null,
	stripeInvoiceId: null,
	releaseCount: 0,
	revision: 0,
	closedAt: null,
	claimedAt: null,
	settledAt: null,
	releasedAt: null,
	writtenOffAt: null,
	writeOffReason: null,
	writeOffEvidence: null,
	voidedAt: null,
	createdAt: new Date("2026-06-01T00:00:00.000Z"),
	updatedAt: new Date("2026-06-01T00:00:00.000Z"),
} as const;

function subscriptionLine(overrides: Record<string, unknown> = {}) {
	return {
		id: "il_base",
		parent: {
			type: "subscription_item_details",
			subscription_item_details: {
				proration: false,
				subscription: "sub_base",
				subscription_item: "si_base",
			},
		},
		subscription: "sub_base",
		pricing: {
			type: "price_details",
			price_details: { price: "price_base", product: "prod_base" },
		},
		period: {
			start: Math.floor(period.periodEnd.getTime() / 1000),
			end: Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000),
		},
		...overrides,
	} as unknown as Stripe.InvoiceLineItem;
}

function draftInvoice(id: string, subscription = "sub_base") {
	return {
		id,
		status: "draft",
		billing_reason: "subscription_cycle",
		customer: "cus_base",
		parent: { subscription_details: { subscription } },
	} as unknown as Stripe.Invoice;
}

function asyncList<T>(values: T[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const value of values) yield value;
		},
	};
}

beforeEach(() => {
	mockDb = createMockDb();
});

describe("invoice generation selection", () => {
	it("rejects malformed sweep cursors and restores a valid keyset tuple", () => {
		expect(parseInvoiceDiscoveryCursor(null)).toBeNull();
		expect(
			parseInvoiceDiscoveryCursor({
				period_end: "not-a-date",
				organization_id: "org_1",
				id: "bp_1",
			}),
		).toBeNull();
		expect(
			parseInvoiceDiscoveryCursor({
				period_end: "2026-07-01T00:00:00.000Z",
				organization_id: "org_1",
				id: "bp_1",
			}),
		).toEqual({
			periodEnd: new Date("2026-07-01T00:00:00.000Z"),
			organizationId: "org_1",
			id: "bp_1",
		});
	});

	it("rotates the no-KV fallback by one bounded page and wraps", () => {
		const epoch = new Date("1970-01-01T00:00:00.000Z");
		expect(invoiceDiscoveryFallbackOffset(epoch, 250)).toBe(0);
		expect(
			invoiceDiscoveryFallbackOffset(new Date("1970-01-02T00:00:00.000Z"), 250),
		).toBe(100);
		expect(
			invoiceDiscoveryFallbackOffset(new Date("1970-01-03T00:00:00.000Z"), 250),
		).toBe(200);
		expect(
			invoiceDiscoveryFallbackOffset(new Date("1970-01-04T00:00:00.000Z"), 250),
		).toBe(50);
		expect(() => invoiceDiscoveryFallbackOffset(epoch, 0)).toThrow(
			"positive integer",
		);
	});

	it("prefilters unresolved ownership, rotates a bounded page, and locks bucket before period", () => {
		const source = readFileSync(
			new URL("../services/invoice-generator.ts", import.meta.url),
			"utf8",
		);
		const discovery = source.slice(
			source.indexOf("function invoiceDiscoveryEligibility"),
			source.indexOf("async function loadInvoiceDiscoveryCursor"),
		);
		for (const marker of [
			"unresolved_reservation.state IN ('reserved', 'parked')",
			"unresolved_reservation.request_may_have_been_sent_at IS NOT NULL",
			"live_tool_job.status IN ('pending', 'processing')",
			"ad_create_owner.usage_reservation_id",
			"ad_mutation_owner.usage_reservation_id",
			"phone_provision_owner.usage_reservation_id",
			"phone_release_owner.usage_reservation_id",
			"pending_carryover.successor_bucket_id",
			"carryover_source.state IN ('reserved', 'parked')",
		]) {
			expect(discovery).toContain(marker);
		}
		expect(source).toContain("INVOICE_DISCOVERY_BATCH_SIZE = 100");
		expect(source).toContain("through: initialCursor");
		expect(source).toContain("countEligibleInvoicePeriods(db");
		expect(source).toContain("utcDay * INVOICE_DISCOVERY_BATCH_SIZE");
		expect(source).toContain("offset > 0 && remaining > 0");
		expect(source).toContain("saveInvoiceDiscoveryCursor(env");

		const claim = source.slice(
			source.indexOf("export async function claimBillingPeriod"),
			source.indexOf("/**\n * Delete cached API-key authorization"),
		);
		expect(claim.indexOf("const [bucketCandidate]")).toBeLessThan(
			claim.indexOf("const [lockedBucket]"),
		);
		expect(claim.indexOf("const [lockedBucket]")).toBeLessThan(
			claim.indexOf("const [period]"),
		);
		expect(claim).toContain('eq(billingPeriods.source, "stripe")');
		expect(claim).toContain("periodCandidate.stripeSubscriptionId");
	});

	it("matches the immutable base Price, subscription, and renewal boundary", () => {
		expect(
			invoiceLineMatchesBillingPeriod(subscriptionLine(), period as never),
		).toBe(true);
		expect(
			invoiceLineMatchesBillingPeriod(
				subscriptionLine({ subscription: "sub_phone" }),
				period as never,
			),
		).toBe(false);
		expect(
			invoiceLineMatchesBillingPeriod(
				subscriptionLine({
					period: {
						start: Math.floor(period.periodStart.getTime() / 1000),
						end: Math.floor(period.periodEnd.getTime() / 1000),
					},
				}),
				period as never,
			),
		).toBe(false);
	});

	it("selects the base renewal draft and ignores another subscription", async () => {
		const base = draftInvoice("in_base");
		const phone = draftInvoice("in_phone", "sub_phone");
		const stripe = {
			invoices: {
				list: () => asyncList([phone, base]),
				listLineItems: (id: string) =>
					asyncList(id === "in_base" ? [subscriptionLine()] : []),
			},
		};
		await expect(
			findExactDraftInvoiceForBillingPeriod(stripe as never, period as never),
		).resolves.toMatchObject({ id: "in_base" });
	});

	it("fails closed when two draft invoices match exactly", async () => {
		const stripe = {
			invoices: {
				list: () => asyncList([draftInvoice("in_1"), draftInvoice("in_2")]),
				listLineItems: () => asyncList([subscriptionLine()]),
			},
		};
		await expect(
			findExactDraftInvoiceForBillingPeriod(stripe as never, period as never),
		).rejects.toThrow("Multiple Stripe draft invoices");
	});
});

describe("billing period claim", () => {
	it("snapshots overage and creates an immutable cycle attempt", async () => {
		mockDb._seed("billingPeriods", [{ ...period }]);
		mockDb._seed("usageBuckets", [
			{
				id: "ub_1",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				metric: "successful_mutation",
				committedUnits: 11_250,
				reservedUnits: 0,
			},
		]);
		mockDb._seed("usageReservations", []);

		const claimed = await claimBillingPeriod(
			mockDb as never,
			period as never,
			{ kind: "cycle", stripeInvoiceId: "in_base" },
			new Date("2026-07-01T00:31:00.000Z"),
		);
		expect(claimed).toBe(true);
		expect(mockDb._getData("billingPeriods")).toMatchObject([
			{
				committedUnitsSnapshot: 11_250,
				effectiveIncludedUnitsSnapshot: 10_000,
				overageUnitsSnapshot: 1_250,
				amountCentsSnapshot: 125,
			},
		]);
		expect(mockDb._getData("billingOperations")).toMatchObject([
			{
				kind: "cycle",
				stripeCustomerId: "cus_base",
				stripeSubscriptionId: "sub_base",
				stripeInvoiceId: "in_base",
				amountCents: 125,
				idempotencyKey: "relayapi:overage:bp_1:cycle:r1",
			},
		]);
		expect(mockDb._getData("billingOperationAttempts")).toMatchObject([
			{
				revision: 1,
				stripeInvoiceId: "in_base",
				amountCents: 125,
			},
		]);
	});

	it("creates invoice authority first for a standalone catch-up", async () => {
		mockDb._seed("billingPeriods", [{ ...period }]);
		mockDb._seed("usageBuckets", [
			{
				id: "ub_1",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				metric: "successful_mutation",
				committedUnits: 11_000,
				reservedUnits: 0,
			},
		]);
		mockDb._seed("usageReservations", []);

		await claimBillingPeriod(
			mockDb as never,
			period as never,
			{ kind: "catchup" },
			new Date("2026-07-01T03:00:00.000Z"),
		);

		expect(mockDb._getData("billingOperations")).toMatchObject([
			{
				kind: "catchup",
				status: "invoice_preparing",
				stripeInvoiceId: null,
				invoiceIdempotencyKey: "relayapi:overage:bp_1:catchup-invoice",
			},
		]);
		expect(mockDb._getData("billingOperationAttempts")).toHaveLength(0);
	});

	it("rejects a computed charge that cannot fit the int4 money column", async () => {
		const oversizedPeriod = {
			...period,
			includedUnits: 0,
			pricePerThousandUnitsCents: 1_000,
		};
		mockDb._seed("billingPeriods", [oversizedPeriod]);
		mockDb._seed("usageBuckets", [
			{
				id: "ub_1",
				organizationId: "org_1",
				billingPeriodId: "bp_1",
				metric: "successful_mutation",
				committedUnits: 2_147_483_648,
				reservedUnits: 0,
			},
		]);
		mockDb._seed("usageReservations", []);

		await expect(
			claimBillingPeriod(
				mockDb as never,
				oversizedPeriod as never,
				{ kind: "cycle", stripeInvoiceId: "in_base" },
				new Date("2026-07-01T00:31:00.000Z"),
			),
		).rejects.toThrow("produced an invalid int4 charge amount");
		expect(mockDb._getData("billingOperations")).toHaveLength(0);
		expect(mockDb._getData("billingOperationAttempts")).toHaveLength(0);
	});
});
