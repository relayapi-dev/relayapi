import { describe, expect, it } from "bun:test";
import {
	digestFinancialExternalSourceId,
	digestFinancialProviderReferences,
	FINANCIAL_INVOICE_RETENTION_YEARS,
	FINANCIAL_OPERATIONAL_RETENTION_DAYS,
	FINANCIAL_RETENTION_BATCH_SIZE,
	FINANCIAL_RETENTION_MAX_PASSES,
	FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS,
	STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS,
} from "../services/financial-retention";
import {
	TENANT_FINANCIAL_RETENTION_STEP,
	TENANT_PURGE_TABLES,
	TENANT_RETAINED_TABLES,
	tenantDeletionStepKeys,
} from "../services/tenant-deletion";

describe("financial retention policy", () => {
	it("digests typed provider references deterministically without retaining raw IDs", async () => {
		const first = await digestFinancialProviderReferences([
			["stripe_customer", "cus_private"],
			["stripe_subscription", "sub_private"],
			["stripe_customer", "cus_private"],
		]);
		const reordered = await digestFinancialProviderReferences([
			["stripe_subscription", "sub_private"],
			["stripe_customer", "cus_private"],
		]);
		expect(first).toBe(reordered);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toContain("cus_private");
		expect(await digestFinancialProviderReferences([])).toBeNull();

		const source = await digestFinancialExternalSourceId(
			"stripe",
			"evt_private",
		);
		expect(source).toMatch(/^[0-9a-f]{64}$/);
		expect(source).not.toContain("evt_private");
	});

	it("runs the receipt snapshot before every operational billing purge", () => {
		const keys = tenantDeletionStepKeys();
		const receiptIndex = keys.indexOf(TENANT_FINANCIAL_RETENTION_STEP);
		expect(receiptIndex).toBeGreaterThan(-1);
		for (const table of [
			"organization_subscriptions",
			"subscription_checkout_operations",
			"billing_outbox",
			"billing_operations",
			"dunning_events",
			"billing_periods",
			"invoices",
			"usage_reservation_carryovers",
			"usage_reservations",
			"usage_buckets",
			"whatsapp_phone_billing_attempts",
			"whatsapp_phone_billing_operations",
		]) {
			const purgeIndex = keys.indexOf(`purge:public.${table}`);
			expect(purgeIndex).toBeGreaterThan(receiptIndex);
		}
		expect(
			TENANT_RETAINED_TABLES.some(
				(entry) => entry.table === "financial_retention_receipts",
			),
		).toBe(true);
		expect(
			TENANT_PURGE_TABLES.some(
				(entry) => (entry.table as string) === "financial_retention_receipts",
			),
		).toBe(false);
	});

	it("digests every immutable phone billing revision before tenant purge", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/financial-retention.ts`,
		).text();
		const tenantSnapshot = source.slice(
			source.indexOf("async function tenantSourceCandidates"),
			source.indexOf("function billingOutboxProviderReferences"),
		);
		expect(tenantSnapshot).toContain(
			'if (source === "phone_billing_operation")',
		);
		expect(tenantSnapshot).toContain("whatsappPhoneBillingOperations");
		expect(tenantSnapshot).toContain("whatsappPhoneBillingAttempts");
		expect(tenantSnapshot).toContain(
			"phoneBillingProviderReferences(row, attempts)",
		);
		expect(source).toContain("attempt.providerEvidence");
	});

	it("keeps every horizon and maintenance loop explicitly bounded", async () => {
		expect(FINANCIAL_OPERATIONAL_RETENTION_DAYS).toBe(90);
		expect(FINANCIAL_INVOICE_RETENTION_YEARS).toBe(7);
		expect(FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS).toBe(25);
		expect(STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS).toBe(1);
		expect(FINANCIAL_RETENTION_BATCH_SIZE).toBeGreaterThan(0);
		expect(FINANCIAL_RETENTION_MAX_PASSES).toBeGreaterThan(0);
		expect(
			FINANCIAL_RETENTION_BATCH_SIZE * FINANCIAL_RETENTION_MAX_PASSES,
		).toBeLessThanOrEqual(10_000);
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/financial-retention.ts`,
		).text();
		const reservationDrain = source.slice(
			source.indexOf("async function pruneExpiredUsageReservations"),
			source.indexOf("async function pruneExpiredUsageBuckets"),
		);
		expect(reservationDrain).toContain(
			'inArray(usageReservations.state, ["committed", "released"])',
		);
		for (const operation of [
			"adCreationOperations",
			"adMutationOperations",
			"whatsappPhoneProvisioningOperations",
			"whatsappPhoneReleaseOperations",
		]) {
			const detach = reservationDrain.indexOf(`.update(${operation})`);
			expect(detach).toBeGreaterThan(-1);
			expect(detach).toBeLessThan(
				reservationDrain.indexOf(".delete(usageReservations)"),
			);
		}
		expect(reservationDrain).toContain(".set({ usageReservationId: null })");
		expect(reservationDrain).toContain(
			".set({ provisioningUsageReservationId: null })",
		);
		expect(reservationDrain).toContain(
			".set({ releaseUsageReservationId: null })",
		);
		expect(reservationDrain).toContain(
			".limit(FINANCIAL_RETENTION_BATCH_SIZE)",
		);
		expect(reservationDrain).toContain(
			'.for("update", { of: usageReservations, skipLocked: true })',
		);
		expect(source).toContain("LATE_BILLING_EFFECT_ALERT_PREFIX");
		expect(source).toContain("+ INTERVAL '7 years'");
	});

	it("never infers Stripe tenant ownership from payload or object IDs", async () => {
		const root = new URL("../../../../", import.meta.url).pathname;
		const [source, webhook] = await Promise.all([
			Bun.file(`${root}apps/api/src/services/financial-retention.ts`).text(),
			Bun.file(`${root}apps/api/src/routes/stripe-webhooks.ts`).text(),
		]);
		const attribution = source.slice(
			source.indexOf("async function stripeAttributionByCurrentBillingState"),
			source.indexOf("async function pruneStripeEvents"),
		);
		const tenantSnapshot = source.slice(
			source.indexOf("async function tenantSourceCandidates"),
			source.indexOf("function billingOutboxProviderReferences"),
		);
		expect(attribution).toContain("organizationSubscriptions");
		expect(attribution).toContain("durableAttribution");
		expect(attribution).toContain("row.organizationId");
		expect(attribution).toContain("legacyRows");
		expect(attribution).toContain('.for("share")');
		expect(attribution).toContain("stripeSubscriptionId");
		expect(attribution).toContain("stripeCustomerId");
		expect(attribution).not.toContain("payload");
		expect(attribution).not.toContain("objectId");
		expect(source).toContain('.for("update")');
		expect(tenantSnapshot).toContain("stripeEvents.customerId");
		expect(tenantSnapshot).toContain(
			"eq(stripeEvents.organizationId, organizationId)",
		);
		expect(tenantSnapshot).toContain("isNull(stripeEvents.organizationId)");
		expect(tenantSnapshot).toContain("row.organizationId === organizationId");
		expect(tenantSnapshot).toContain(
			"row.customerId === subscription.stripeCustomerId",
		);
		expect(source).toContain("financialStripeEventAdvisoryLockKey");
		expect(tenantSnapshot).toContain("stripeEventIdsToDelete");
		expect(tenantSnapshot).toContain(".delete(stripeEvents)");
		expect(tenantSnapshot).toContain('sourceKind: "stripe_event_global"');
		expect(tenantSnapshot).not.toContain(".offset(");
		expect(webhook).toContain("financialRetentionReceipts.sourceId");
		expect(webhook).toContain("stripe_event_global");
		expect(webhook).toContain("pg_advisory_xact_lock");
	});

	it("holds do not extend operational payload or URL clocks", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/financial-retention.ts`,
		).text();
		const hostedUrlRedaction = source.slice(
			source.indexOf("async function redactExpiredInvoiceUrls"),
			source.indexOf("async function pruneExpiredUsageReservations"),
		);
		const operational = source.slice(
			source.indexOf("async function pruneCheckoutOperations"),
			source.indexOf("async function redactExpiredInvoiceUrls"),
		);
		expect(hostedUrlRedaction).not.toContain("erasureHolds");
		expect(operational).not.toContain("erasureHolds");
		expect(source).toContain("stripeHostedUrl: null");
		expect(source).toContain("payload: sql`'{}'::jsonb`");
	});

	it("retains truthful unresolved usage and child attempt evidence", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/financial-retention.ts`,
		).text();
		expect(source).toContain("status: billingPeriodState");
		expect(source).toContain("billingPeriodReceiptStatus(billingPeriodState)");
		expect(source).toContain(
			"terminal_period.state IN ('settled', 'released', 'void', 'written_off')",
		);
		expect(source).toContain("billingOperationProviderReferences");
		expect(source).toContain("attempt.providerEvidence");
		expect(source).toContain("getUsageCarryoverContributions");
		expect(source).toContain("Usage carryover remains unresolved for bucket");
		expect(source).toContain("effectiveCarryoverAllowance");
		const childDelete = source.indexOf(
			"await tx.delete(billingOperationAttempts)",
		);
		const parentDelete = source.indexOf(
			"await tx.delete(billingOperations)",
			childDelete,
		);
		expect(childDelete).toBeGreaterThan(-1);
		expect(parentDelete).toBeGreaterThan(childDelete);
	});

	it("retains unresolved billing operations and parked Stripe receipts until disposition", async () => {
		const root = new URL("../../../../", import.meta.url).pathname;
		const [retention, webhook] = await Promise.all([
			Bun.file(`${root}apps/api/src/services/financial-retention.ts`).text(),
			Bun.file(`${root}apps/api/src/routes/stripe-webhooks.ts`).text(),
		]);
		const operationPrune = retention.slice(
			retention.indexOf("async function pruneBillingOperations"),
			retention.indexOf("async function pruneDunningEvents"),
		);
		expect(operationPrune).toContain('"succeeded"');
		expect(operationPrune).toContain('"released"');
		expect(operationPrune).toContain('"written_off"');
		expect(operationPrune).not.toContain('"unknown"');
		expect(operationPrune).not.toContain('"manual_review"');
		expect(operationPrune).not.toContain('"terminal_failed"');

		const stripePrune = retention.slice(
			retention.indexOf("async function pruneStripeEvents"),
			retention.indexOf("async function redactExpiredInvoiceUrls"),
		);
		expect(stripePrune).toContain(
			'eq(stripeEvents.lastErrorClass, "permanent")',
		);
		expect(stripePrune).not.toContain(
			'eq(stripeEvents.status, "manual_review")',
		);
		expect(webhook).toContain("stripeEventAutomaticRecoveryStatus()");
		expect(webhook).toContain("STRIPE_AUTOMATIC_RECOVERY_ERROR_CLASSES");
		expect(webhook).not.toContain(
			'STRIPE_AUTOMATIC_RECOVERY_ERROR_CLASSES = [\n\t"permanent"',
		);
	});

	it("falls back to durable Stripe customer attribution when a historic subscription is gone", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/financial-retention.ts`,
		).text();
		const attribution = source.slice(
			source.indexOf("async function stripeAttributionByCurrentBillingState"),
			source.indexOf("async function pruneStripeEvents"),
		);
		expect(attribution).toContain("legacyRows.flatMap(({ customerId })");
		expect(attribution).toContain("bySubscription.get(row.subscriptionId)");
		expect(attribution).toContain("byCustomer.get(row.customerId)");
		expect(attribution).toContain("const matches = new Set(");
		expect(attribution).toContain("matches.size === 1");
		expect(attribution.indexOf("durableAttribution")).toBeLessThan(
			attribution.indexOf("bySubscription"),
		);
	});
});
