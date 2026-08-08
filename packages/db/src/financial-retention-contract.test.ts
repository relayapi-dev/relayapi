/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getExecutablePostgresRetentionContract } from "./executable-retention-contracts";
import {
	FINANCIAL_RETENTION_CLASSES,
	FINANCIAL_RETENTION_SOURCE_KINDS,
	FINANCIAL_RETENTION_STATUSES,
} from "./financial-retention-contracts";
import { getPrivacyRetentionStore } from "./privacy-retention-registry";
import { financialRetentionReceipts } from "./schema";

test("financial receipts are detached, normalized, and strictly constrained", () => {
	const config = getTableConfig(financialRetentionReceipts);
	expect(config.foreignKeys).toHaveLength(0);
	expect(config.columns.some((column) => column.dataType === "json")).toBe(
		false,
	);
	expect(config.columns.some((column) => column.name === "updated_at")).toBe(
		false,
	);
	expect(config.columns.map(({ name }) => name)).not.toContain("payload");
	expect(config.columns.map(({ name }) => name)).not.toContain("error");
	expect(config.columns.map(({ name }) => name)).not.toContain("provider_id");

	const checks = new Set(config.checks.map(({ name }) => name));
	for (const required of [
		"financial_retention_receipts_source_kind_check",
		"financial_retention_receipts_retention_class_check",
		"financial_retention_receipts_status_check",
		"financial_retention_receipts_identity_check",
		"financial_retention_receipts_provider_digest_check",
		"financial_retention_receipts_provider_digest_source_check",
		"financial_retention_receipts_status_source_check",
		"financial_retention_receipts_value_shape_check",
		"financial_retention_receipts_retention_clock_check",
	]) {
		expect(checks).toContain(required);
	}
	const indexes = new Set(config.indexes.map(({ config }) => config.name));
	expect(indexes).toContain("financial_retention_receipts_tenant_source_uniq");
	expect(indexes).toContain("financial_retention_receipts_global_source_uniq");
	expect(indexes).toContain("financial_retention_receipts_expiry_idx");
	expect(FINANCIAL_RETENTION_SOURCE_KINDS).toHaveLength(11);
	expect(FINANCIAL_RETENTION_SOURCE_KINDS).toContain("phone_billing_operation");
	expect(FINANCIAL_RETENTION_CLASSES).toEqual([
		"financial_7_years",
		"usage_25_months",
		"provider_receipt_1_year",
	]);
	expect(FINANCIAL_RETENTION_STATUSES).toContain("manual_review");
	expect(FINANCIAL_RETENTION_STATUSES).not.toContain("terminal_failed");
	expect(FINANCIAL_RETENTION_STATUSES).toContain("written_off");
	const stripeEvents = getExecutablePostgresRetentionContract(
		"postgres:public.stripe_events",
	);
	expect(stripeEvents?.cutoff.unresolvedPredicate).toContain(
		"last_error_class IS DISTINCT FROM 'permanent'",
	);
	expect(stripeEvents?.horizons.delete?.predicate).toContain(
		"last_error_class = 'permanent'",
	);
	const billingOperations = getExecutablePostgresRetentionContract(
		"postgres:public.billing_operations",
	);
	expect(billingOperations?.cutoff.unresolvedPredicate).toBe(
		"status NOT IN ('succeeded', 'released', 'written_off')",
	);
	expect(billingOperations?.horizons.delete?.predicate).toBe(
		"status IN ('succeeded', 'released', 'written_off')",
	);
	expect(
		getExecutablePostgresRetentionContract("postgres:public.invoices")
			?.holdTreatment,
	).toBe("minimize");
	expect(getPrivacyRetentionStore("postgres:public.invoices")).toMatchObject({
		legalHold: "minimize",
		secretFields: ["stripe_hosted_url"],
	});
});
