/**
 * Minimized financial evidence retained after operational billing rows are
 * purged. These vocabularies are intentionally application-owned and closed:
 * adding a source or status requires an explicit schema and retention review.
 */
import type { ExecutablePostgresRetentionContract } from "./executable-retention-contracts";
import { postgresRetentionHoldTreatment } from "./postgres-retention-hold-policy";

export const FINANCIAL_RETENTION_SOURCE_KINDS = [
	"subscription_snapshot",
	"invoice",
	"usage_bucket",
	"billing_period",
	"billing_operation",
	"phone_billing_operation",
	"dunning_event",
	"checkout_operation",
	"billing_outbox",
	"stripe_event_financial",
	"stripe_event_global",
] as const;

export const FINANCIAL_RETENTION_CLASSES = [
	"financial_7_years",
	"usage_25_months",
	"provider_receipt_1_year",
] as const;

export const FINANCIAL_RETENTION_STATUSES = [
	"active",
	"pending",
	"succeeded",
	"failed",
	"unknown",
	"manual_review",
	"cancelled",
	"paid",
	"void",
	"settled",
	"released",
	"written_off",
] as const;

export type FinancialRetentionSourceKind =
	(typeof FINANCIAL_RETENTION_SOURCE_KINDS)[number];
export type FinancialRetentionClass =
	(typeof FINANCIAL_RETENTION_CLASSES)[number];
export type FinancialRetentionStatus =
	(typeof FINANCIAL_RETENTION_STATUSES)[number];

const FINANCIAL_RETENTION_RUNTIME =
	"apps/api/src/services/financial-retention.ts" as const;
const FINANCIAL_RETENTION_TEST =
	"apps/api/src/__tests__/financial-retention.test.ts" as const;
const FINANCIAL_RETENTION_SCHEDULE = "apps/api/src/scheduled/index.ts" as const;

function financialHandler(id: string) {
	return {
		id,
		source: FINANCIAL_RETENTION_RUNTIME,
		exportName: "retainFinancialData",
		testSource: FINANCIAL_RETENTION_TEST,
		testMarker: "keeps every horizon and maintenance loop explicitly bounded",
	} as const;
}

function dailyFinancialCadence() {
	return {
		cron: "0 9 * * *",
		taskName: "financial_retention",
		source: FINANCIAL_RETENTION_SCHEDULE,
	} as const;
}

/**
 * Specialized financial state-machine drains. All use one scheduled entrypoint
 * but keep distinct store contracts because their clocks, hold treatment, and
 * preservation rules are intentionally different.
 */
const FINANCIAL_POSTGRES_RETENTION_CONTRACT_INPUTS = [
	{
		storeId: "postgres:public.subscription_checkout_operations",
		handler: financialHandler("retain_subscription_checkout_operations"),
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate:
				"status IN ('completed', 'blocked', 'failed', 'expired') OR session_expires_at <= now",
			unresolvedPredicate: "status IN ('creating', 'unknown')",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "status IN ('creating', 'unknown')",
				preserves:
					"tenant, normalized unknown outcome, clock, and provider-reference digest",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "terminal, unresolved, or provider-expired checkout",
				preserves: "current subscription entitlement and minimized evidence",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["updated_at", "id"],
			indexName: "subscription_checkout_operations_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.stripe_events",
		handler: financialHandler("retain_stripe_events"),
		cutoff: {
			timestampExpression: "received_at",
			terminalPredicate:
				"status = 'succeeded' OR (status = 'failed' AND last_error_class = 'permanent')",
			unresolvedPredicate:
				"status = 'manual_review' OR (status = 'failed' AND last_error_class IS DISTINCT FROM 'permanent')",
		},
		horizons: {
			minimize: {
				after: { value: 0, unit: "at_expiry" },
				predicate: "status = 'succeeded'",
				preserves:
					"typed processing outcome while shredding payload immediately",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate:
					"status = 'succeeded' OR (status = 'failed' AND last_error_class = 'permanent')",
				preserves:
					"one-year global event digest and deterministic tenant evidence from immutable organization attribution for operator-abandoned events",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["received_at", "id"],
			indexName: "stripe_events_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.billing_outbox",
		handler: financialHandler("retain_billing_outbox"),
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate: "age >= 90 days",
			unresolvedPredicate: "status <> 'succeeded'",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "status <> 'succeeded'",
				preserves:
					"tenant, manual outcome, clock, and provider-reference digest",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "TRUE",
				preserves:
					"canonical subscription/invoice state and minimized evidence",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["updated_at", "id"],
			indexName: "billing_outbox_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.billing_operation_attempts",
		handler: financialHandler("retain_billing_operation_attempts"),
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate:
				"parent operation is terminal and parent updated_at age >= 90 days",
			unresolvedPredicate: "status IN ('requesting', 'unknown')",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "parent operation is terminal",
				preserves:
					"attempt revisions, outcomes, provider evidence, and idempotency identities in the parent financial receipt digest",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "parent operation is terminal",
				preserves: "seven-year normalized parent financial receipt",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["billing_operation_id", "revision"],
			indexName: "billing_operation_attempts_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.billing_operations",
		handler: financialHandler("retain_billing_operations"),
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate:
				"status IN ('succeeded', 'released', 'written_off') AND age >= 90 days",
			unresolvedPredicate:
				"status NOT IN ('succeeded', 'released', 'written_off')",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "status IN ('succeeded', 'released', 'written_off')",
				preserves:
					"period, amount, currency, quantity, normalized outcome, and provider-reference digest",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "status IN ('succeeded', 'released', 'written_off')",
				preserves: "seven-year normalized financial receipt",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["updated_at", "id"],
			indexName: "billing_operations_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.dunning_events",
		handler: financialHandler("retain_dunning_events"),
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate: "age >= 90 days",
			unresolvedPredicate:
				"status IN ('failed', 'terminal_failed') OR deactivation_status IN ('unknown', 'manual_review')",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "TRUE",
				preserves:
					"tenant, normalized delivery/deactivation outcome, clock, and provider-reference digest",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "TRUE",
				preserves: "seven-year normalized financial receipt",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["updated_at", "id"],
			indexName: "dunning_events_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.billing_periods",
		handler: financialHandler("retain_billing_periods"),
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate:
				"period_end + 25 months <= now AND no billing operation or usage bucket remains",
			unresolvedPredicate: "state = 'claimed'",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "TRUE",
				preserves:
					"period, amount, currency, units, and normalized settlement outcome",
			},
			delete: {
				after: { value: 90, unit: "days" },
				predicate: "no billing operation or usage bucket remains",
				preserves: "seven-year normalized financial receipt",
			},
		},
		holdScope: "none",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["period_end", "id"],
			indexName: "billing_periods_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.invoices",
		handler: financialHandler("retain_invoices"),
		cutoff: {
			timestampExpression:
				"COALESCE(paid_at, finalized_at, period_end, updated_at)",
			terminalPredicate: "closed financial record",
		},
		horizons: {
			minimize: {
				after: { value: 90, unit: "days" },
				predicate: "stripe_hosted_url IS NOT NULL",
				preserves:
					"invoice periods, amounts, counts, state, and reconciliation ID",
			},
			delete: {
				after: { value: 84, unit: "months" },
				predicate: "no active organization hold",
				preserves: "in-window detached tenant-erasure evidence",
			},
		},
		holdScope: "organization",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: [
				"COALESCE(paid_at, finalized_at, period_end, updated_at)",
				"id",
			],
			indexName: "invoices_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.usage_buckets",
		handler: financialHandler("retain_usage_buckets"),
		cutoff: {
			timestampExpression: "period_end",
			terminalPredicate: "period_end + 25 months <= now",
		},
		horizons: {
			minimize: null,
			delete: {
				after: { value: 25, unit: "months" },
				predicate: "no reservation and no active organization hold",
				preserves: "in-window usage and detached tenant-erasure aggregate",
			},
		},
		holdScope: "organization",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["period_end", "id"],
			indexName: "usage_buckets_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.usage_reservations",
		handler: financialHandler("retain_usage_reservations"),
		cutoff: {
			timestampExpression: "parent usage_buckets.period_end",
			terminalPredicate:
				"state IN ('committed', 'released') AND parent period_end + 25 months <= now",
		},
		horizons: {
			minimize: null,
			delete: {
				after: { value: 25, unit: "months" },
				predicate:
					"parent bucket is deletable and not held; detach every durable provider-operation link in the same locked transaction before deletion",
				preserves:
					"bucket aggregate within its configured window and every unresolved reservation-operation provenance link",
			},
		},
		holdScope: "organization",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["bucket_id", "id"],
			indexName: "usage_reservations_retention_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
	{
		storeId: "postgres:public.financial_retention_receipts",
		handler: financialHandler("retain_financial_retention_receipts"),
		cutoff: {
			timestampExpression: "retained_until",
			terminalPredicate: "retained_until <= now",
		},
		horizons: {
			minimize: null,
			delete: {
				after: { value: 0, unit: "at_expiry" },
				predicate:
					"retained_until <= now AND no active matching organization hold",
				preserves: "nothing beyond the configured financial horizon",
			},
		},
		holdScope: "organization",
		batch: {
			rows: 250,
			maxPasses: 20,
			orderBy: ["retained_until", "id"],
			indexName: "financial_retention_receipts_expiry_idx",
		},
		cadence: dailyFinancialCadence(),
		owner: "data-governance",
	},
] as const;

export const FINANCIAL_POSTGRES_RETENTION_CONTRACTS =
	FINANCIAL_POSTGRES_RETENTION_CONTRACT_INPUTS.map((contract) => {
		return {
			...contract,
			holdTreatment: postgresRetentionHoldTreatment(contract.storeId),
		};
	}) satisfies readonly ExecutablePostgresRetentionContract[];
