import {
	adCreationOperations,
	adMutationOperations,
	billingOperationAttempts,
	billingOperations,
	billingOutbox,
	billingPeriods,
	createDb,
	type Database,
	dunningEvents,
	erasureHolds,
	financialRetentionReceipts,
	invoices,
	organizationSubscriptions,
	stripeEvents,
	subscriptionCheckoutOperations,
	usageBuckets,
	usageReservationCarryovers,
	usageReservations,
	whatsappPhoneBillingAttempts,
	whatsappPhoneBillingOperations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { LATE_BILLING_EFFECT_ALERT_PREFIX } from "../config/billing";
import { sha256Hex } from "../lib/durable-operation";
import type { Env } from "../types";
import {
	effectiveCarryoverAllowance,
	getUsageCarryoverContributions,
} from "./usage-carryover";

export const FINANCIAL_OPERATIONAL_RETENTION_DAYS = 90;
export const FINANCIAL_INVOICE_RETENTION_YEARS = 7;
export const FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS = 25;
export const STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS = 1;
export const FINANCIAL_RETENTION_BATCH_SIZE = 250;
export const FINANCIAL_RETENTION_MAX_PASSES = 20;

const DAY_MS = 86_400_000;

function addUtcMonthsClamped(value: Date, months: number): Date {
	const targetMonth = value.getUTCMonth() + months;
	const targetYear = value.getUTCFullYear() + Math.floor(targetMonth / 12);
	const normalizedMonth = ((targetMonth % 12) + 12) % 12;
	const lastDay = new Date(
		Date.UTC(targetYear, normalizedMonth + 1, 0),
	).getUTCDate();
	return new Date(
		Date.UTC(
			targetYear,
			normalizedMonth,
			Math.min(value.getUTCDate(), lastDay),
			value.getUTCHours(),
			value.getUTCMinutes(),
			value.getUTCSeconds(),
			value.getUTCMilliseconds(),
		),
	);
}

type ReceiptInsert = typeof financialRetentionReceipts.$inferInsert;
type ReceiptInsertWithSql = Omit<ReceiptInsert, "retainedUntil"> & {
	retainedUntil: ReturnType<typeof sql>;
};
type ReceiptStatus = ReceiptInsert["status"];
type ReceiptSourceKind = ReceiptInsert["sourceKind"];
type ReceiptClass = ReceiptInsert["retentionClass"];
type FinancialTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

type ProviderReference = readonly [
	kind: string,
	value: string | null | undefined,
];

interface ReceiptCandidate {
	sourceKind: ReceiptSourceKind;
	sourceId: string;
	organizationTombstoneId: string | null;
	retentionClass: ReceiptClass;
	status: ReceiptStatus;
	periodStart?: Date | null;
	periodEnd?: Date | null;
	amountCents?: number | null;
	currency?: string | null;
	quantity?: number | null;
	includedQuantity?: number | null;
	overageQuantity?: number | null;
	providerReferences?: readonly ProviderReference[];
	retentionAnchorAt: Date;
}

type BillingOperationRow = typeof billingOperations.$inferSelect;
type BillingPeriodRow = typeof billingPeriods.$inferSelect;
type BillingOperationAttemptRow = typeof billingOperationAttempts.$inferSelect;
type PhoneBillingOperationRow =
	typeof whatsappPhoneBillingOperations.$inferSelect;
type PhoneBillingAttemptRow = typeof whatsappPhoneBillingAttempts.$inferSelect;

function serializedEvidence(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return JSON.stringify(value);
}

function billingOperationProviderReferences(
	operation: BillingOperationRow,
	period: BillingPeriodRow,
	attempts: readonly BillingOperationAttemptRow[],
): ProviderReference[] {
	return [
		["stripe_customer", operation.stripeCustomerId],
		["stripe_subscription", operation.stripeSubscriptionId],
		["stripe_invoice", operation.stripeInvoiceId],
		["stripe_invoice_item", operation.stripeInvoiceItemId],
		["stripe_idempotency", operation.idempotencyKey],
		["billing_period_writeoff_reason", period.writeOffReason],
		[
			"billing_period_writeoff_evidence",
			serializedEvidence(period.writeOffEvidence),
		],
		...attempts.flatMap((attempt): ProviderReference[] => [
			[`attempt_${attempt.revision}_id`, attempt.id],
			[`attempt_${attempt.revision}_status`, attempt.status],
			[`attempt_${attempt.revision}_invoice`, attempt.stripeInvoiceId],
			[`attempt_${attempt.revision}_invoice_item`, attempt.stripeInvoiceItemId],
			[`attempt_${attempt.revision}_idempotency`, attempt.idempotencyKey],
			[
				`attempt_${attempt.revision}_provider_evidence`,
				serializedEvidence(attempt.providerEvidence),
			],
		]),
	];
}

function groupBillingOperationAttempts(
	attempts: readonly BillingOperationAttemptRow[],
): Map<string, BillingOperationAttemptRow[]> {
	const byOperation = new Map<string, BillingOperationAttemptRow[]>();
	for (const attempt of attempts) {
		const rows = byOperation.get(attempt.billingOperationId) ?? [];
		rows.push(attempt);
		byOperation.set(attempt.billingOperationId, rows);
	}
	return byOperation;
}

function phoneBillingProviderReferences(
	operation: PhoneBillingOperationRow,
	attempts: readonly PhoneBillingAttemptRow[],
): ProviderReference[] {
	return [
		["phone_billing_state", operation.state],
		["phone_billing_revision", String(operation.revision)],
		["phone_billing_desired_quantity", String(operation.desiredQuantity)],
		["phone_billing_applied_quantity", String(operation.appliedQuantity)],
		["stripe_customer", operation.stripeCustomerId],
		["stripe_checkout_session", operation.stripeCheckoutSessionId],
		["stripe_subscription", operation.stripeSubscriptionId],
		["stripe_subscription_item", operation.stripeSubscriptionItemId],
		["stripe_invoice", operation.stripeLatestInvoiceId],
		["stripe_idempotency", operation.idempotencyKey],
		["phone_billing_last_error", operation.lastError],
		...attempts.flatMap((attempt): ProviderReference[] => [
			[`attempt_${attempt.revision}_id`, attempt.id],
			[`attempt_${attempt.revision}_status`, attempt.status],
			[
				`attempt_${attempt.revision}_desired_quantity`,
				String(attempt.desiredQuantity),
			],
			[
				`attempt_${attempt.revision}_prior_applied_quantity`,
				String(attempt.priorAppliedQuantity),
			],
			[`attempt_${attempt.revision}_customer`, attempt.stripeCustomerId],
			[
				`attempt_${attempt.revision}_checkout_session`,
				attempt.stripeCheckoutSessionId,
			],
			[
				`attempt_${attempt.revision}_subscription`,
				attempt.stripeSubscriptionId,
			],
			[
				`attempt_${attempt.revision}_subscription_item`,
				attempt.stripeSubscriptionItemId,
			],
			[`attempt_${attempt.revision}_invoice`, attempt.stripeLatestInvoiceId],
			[`attempt_${attempt.revision}_idempotency`, attempt.idempotencyKey],
			[
				`attempt_${attempt.revision}_request_boundary`,
				attempt.requestMayHaveBeenSentAt?.toISOString(),
			],
			[
				`attempt_${attempt.revision}_provider_evidence`,
				serializedEvidence(attempt.providerEvidence),
			],
			[
				`attempt_${attempt.revision}_resolved_at`,
				attempt.resolvedAt?.toISOString(),
			],
		]),
	];
}

export type TenantFinancialRetentionCursor = Record<string, unknown> & {
	source_index?: number;
	after_id?: string;
};

export interface TenantFinancialRetentionBatchResult {
	completed: boolean;
	cursor: TenantFinancialRetentionCursor | null;
	receiptsWritten: number;
}

export interface FinancialRetentionResult {
	receiptsWritten: number;
	operationalRowsDeleted: number;
	hostedUrlsRedacted: number;
	usageRowsDeleted: number;
	invoicesDeleted: number;
	expiredReceiptsDeleted: number;
}

function nonEmpty(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

/**
 * Hash only typed, sorted references. The digest is stable across call sites,
 * while labels prevent equal raw values from colliding across provider fields.
 */
export async function digestFinancialProviderReferences(
	references: readonly ProviderReference[],
): Promise<string | null> {
	const normalized = [
		...new Set(
			references.flatMap(([kind, value]) => {
				const normalizedValue = nonEmpty(value);
				return normalizedValue ? [`${kind}=${normalizedValue}`] : [];
			}),
		),
	].sort();
	if (normalized.length === 0) return null;
	return sha256Hex(
		`relayapi:financial-provider-references:v1\n${normalized.join("\n")}`,
	);
}

export async function digestFinancialExternalSourceId(
	provider: "stripe",
	sourceId: string,
): Promise<string> {
	return sha256Hex(
		`relayapi:financial-external-source:v1:${provider}:${sourceId}`,
	);
}

export function financialStripeEventAdvisoryLockKey(
	sourceDigest: string,
): string {
	return `relayapi:financial-stripe-event:v1:${sourceDigest}`;
}

function retainedUntilSql(
	anchor: Date,
	retentionClass: ReceiptClass,
): ReturnType<typeof sql> {
	switch (retentionClass) {
		case "financial_7_years":
			return sql`${anchor} + INTERVAL '7 years'`;
		case "usage_25_months":
			return sql`${anchor} + INTERVAL '25 months'`;
		case "provider_receipt_1_year":
			return sql`${anchor} + INTERVAL '1 year'`;
	}
}

async function toReceiptInsert(
	candidate: ReceiptCandidate,
	now: Date,
): Promise<ReceiptInsertWithSql> {
	return {
		sourceKind: candidate.sourceKind,
		sourceId: candidate.sourceId,
		organizationTombstoneId: candidate.organizationTombstoneId,
		retentionClass: candidate.retentionClass,
		status: candidate.status,
		periodStart: candidate.periodStart ?? null,
		periodEnd: candidate.periodEnd ?? null,
		amountCents: candidate.amountCents ?? null,
		currency: candidate.currency ?? null,
		quantity: candidate.quantity ?? null,
		includedQuantity: candidate.includedQuantity ?? null,
		overageQuantity: candidate.overageQuantity ?? null,
		providerReferenceDigest: await digestFinancialProviderReferences(
			candidate.providerReferences ?? [],
		),
		retentionAnchorAt: candidate.retentionAnchorAt,
		recordedAt: now,
		retainedUntil: retainedUntilSql(
			candidate.retentionAnchorAt,
			candidate.retentionClass,
		),
	};
}

async function writeReceiptCandidates(
	db: Pick<FinancialTransaction, "insert">,
	candidates: readonly ReceiptCandidate[],
	now: Date,
): Promise<number> {
	const activeCandidates = candidates.filter((candidate) => {
		const months =
			candidate.retentionClass === "financial_7_years"
				? FINANCIAL_INVOICE_RETENTION_YEARS * 12
				: candidate.retentionClass === "usage_25_months"
					? FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS
					: STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS * 12;
		return addUtcMonthsClamped(candidate.retentionAnchorAt, months) > now;
	});
	if (activeCandidates.length === 0) return 0;
	const values = await Promise.all(
		activeCandidates.map((candidate) => toReceiptInsert(candidate, now)),
	);
	const inserted = await db
		.insert(financialRetentionReceipts)
		.values(values)
		.onConflictDoNothing()
		.returning({ id: financialRetentionReceipts.id });
	return inserted.length;
}

function subscriptionReceiptStatus(
	status: string,
): "active" | "failed" | "cancelled" {
	if (status === "cancelled") return "cancelled";
	if (status === "past_due") return "failed";
	return "active";
}

function invoiceReceiptStatus(status: string): "pending" | "paid" | "void" {
	if (status === "paid") return "paid";
	if (status === "void") return "void";
	return "pending";
}

function billingPeriodReceiptStatus(
	status: string,
): "pending" | "settled" | "released" | "void" | "written_off" {
	if (status === "settled") return "settled";
	if (status === "released") return "released";
	if (status === "written_off") return "written_off";
	if (status === "void") return "void";
	return "pending";
}

function operationReceiptStatus(status: string): ReceiptStatus {
	switch (status) {
		case "succeeded":
			return "succeeded";
		case "unknown":
			return "unknown";
		case "manual_review":
			return "manual_review";
		case "released":
			return "released";
		case "written_off":
			return "written_off";
		case "failed":
		case "terminal_failed":
			return "failed";
		default:
			return "pending";
	}
}

function phoneBillingReceiptStatus(status: string): ReceiptStatus {
	if (status === "applied") return "succeeded";
	if (status === "manual_review") return "manual_review";
	if (status === "unknown" || status === "request_may_have_been_sent") {
		return "unknown";
	}
	return "pending";
}

function dunningReceiptStatus(input: {
	status: string;
	deactivationStatus: string;
}): ReceiptStatus {
	if (input.deactivationStatus === "manual_review") return "manual_review";
	if (input.deactivationStatus === "unknown") return "unknown";
	if (
		input.status === "terminal_failed" ||
		input.status === "failed" ||
		input.deactivationStatus === "failed"
	) {
		return "failed";
	}
	if (
		input.status === "sent" &&
		(input.deactivationStatus === "not_applicable" ||
			input.deactivationStatus === "succeeded")
	) {
		return "succeeded";
	}
	return "pending";
}

function stripeReceiptStatus(status: string): ReceiptStatus {
	if (status === "succeeded") return "succeeded";
	if (status === "manual_review") return "manual_review";
	if (status === "failed") return "failed";
	return "pending";
}

function afterIdCondition(column: Parameters<typeof gt>[0], afterId?: string) {
	return afterId ? gt(column, afterId) : undefined;
}

const TENANT_FINANCIAL_SOURCES = [
	"subscription_snapshot",
	"phone_billing_operation",
	"invoice",
	"usage_bucket",
	"billing_period",
	"billing_operation",
	"dunning_event",
	"checkout_operation",
	"billing_outbox",
	"stripe_event_financial",
] as const;

async function tenantSourceCandidates(
	tx: FinancialTransaction,
	organizationId: string,
	sourceIndex: number,
	cursor: TenantFinancialRetentionCursor,
	now: Date,
): Promise<{
	candidates: ReceiptCandidate[];
	sourceIds: string[];
	stripeEventIdsToDelete?: string[];
	repeatSource?: boolean;
}> {
	const source = TENANT_FINANCIAL_SOURCES[sourceIndex];
	const afterId = cursor.after_id;
	if (!source) return { candidates: [], sourceIds: [] };

	if (source === "subscription_snapshot") {
		const rows = await tx
			.select()
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId))
			.for("update");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => ({
				sourceKind: source,
				sourceId: row.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: subscriptionReceiptStatus(row.status),
				// Subscription rows are mutable provider/current-state pointers.
				// Historical price, allowance, usage, and window truth is retained
				// only from the immutable billing_periods snapshot below.
				periodStart: null,
				periodEnd: null,
				amountCents: null,
				currency: null,
				quantity: null,
				includedQuantity: null,
				overageQuantity: null,
				providerReferences: [
					["stripe_customer", row.stripeCustomerId],
					["stripe_subscription", row.stripeSubscriptionId],
					["stripe_metered_item", row.stripeMeteredItemId],
				],
				// The source row is current state, not historical evidence. Tenant
				// closure starts the detached snapshot's financial clock.
				retentionAnchorAt: now,
			})),
		};
	}

	if (source === "phone_billing_operation") {
		const rows = await tx
			.select()
			.from(whatsappPhoneBillingOperations)
			.where(eq(whatsappPhoneBillingOperations.organizationId, organizationId))
			.for("update");
		const operation = rows[0];
		const attempts =
			operation === undefined
				? []
				: await tx
						.select()
						.from(whatsappPhoneBillingAttempts)
						.where(
							eq(
								whatsappPhoneBillingAttempts.phoneBillingOperationId,
								operation.id,
							),
						)
						.orderBy(asc(whatsappPhoneBillingAttempts.revision))
						.for("share");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => ({
				sourceKind: source,
				sourceId: row.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: phoneBillingReceiptStatus(row.state),
				quantity: row.desiredQuantity,
				providerReferences: phoneBillingProviderReferences(row, attempts),
				// This is a current recurring-charge snapshot, so tenant closure
				// starts the detached evidence clock just like subscription state.
				retentionAnchorAt: now,
			})),
		};
	}

	if (source === "invoice") {
		const rows = await tx
			.select()
			.from(invoices)
			.where(
				and(
					eq(invoices.organizationId, organizationId),
					afterIdCondition(invoices.id, afterId),
					sql`COALESCE(
							${invoices.paidAt},
							${invoices.finalizedAt},
							${invoices.periodEnd},
							${invoices.updatedAt}
						) + INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(invoices.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => ({
				sourceKind: source,
				sourceId: row.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: invoiceReceiptStatus(row.status),
				periodStart: row.periodStart,
				periodEnd: row.periodEnd,
				amountCents: row.totalCents,
				currency: "usd",
				quantity: row.apiCallsCount,
				includedQuantity: row.apiCallsIncluded,
				overageQuantity: row.overageCalls,
				providerReferences: [["stripe_invoice", row.stripeInvoiceId]],
				retentionAnchorAt:
					row.paidAt ?? row.finalizedAt ?? row.periodEnd ?? row.updatedAt,
			})),
		};
	}

	if (source === "usage_bucket") {
		const rows = await tx
			.select({
				bucket: usageBuckets,
				billingPeriodState: billingPeriods.state,
			})
			.from(usageBuckets)
			.leftJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(usageBuckets.organizationId, organizationId),
					afterIdCondition(usageBuckets.id, afterId),
					sql`${usageBuckets.periodEnd} + INTERVAL '25 months' > ${now}`,
				),
			)
			.orderBy(asc(usageBuckets.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update");
		const carryovers = await getUsageCarryoverContributions(tx, {
			organizationId,
			successorBucketIds: rows.map(({ bucket }) => bucket.id),
		});
		const unresolved = rows.find(
			({ bucket }) => (carryovers.get(bucket.id)?.pendingUnits ?? 0) > 0,
		);
		if (unresolved) {
			// Tenant erasure must not turn an N reservation into a fabricated K=0
			// financial fact. Retry after ordinary reconciliation or an audited
			// operator write-off terminalizes the source reservation.
			throw new Error(
				`Usage carryover remains unresolved for bucket ${unresolved.bucket.id}`,
			);
		}
		return {
			sourceIds: rows.map(({ bucket }) => bucket.id),
			candidates: rows.map(({ bucket: row, billingPeriodState }) => {
				const carryoverCommitted = carryovers.get(row.id)?.committedUnits ?? 0;
				const included =
					effectiveCarryoverAllowance(row.includedUnits, carryoverCommitted) ??
					0;
				return {
					sourceKind: source,
					sourceId: row.id,
					organizationTombstoneId: organizationId,
					retentionClass: "usage_25_months",
					status: billingPeriodState
						? billingPeriodReceiptStatus(billingPeriodState)
						: "released",
					periodStart: row.periodStart,
					periodEnd: row.periodEnd,
					quantity: row.committedUnits,
					includedQuantity: included,
					overageQuantity:
						row.includedUnits === null
							? 0
							: Math.max(0, row.committedUnits - included),
					retentionAnchorAt: row.periodEnd,
				};
			}),
		};
	}

	if (source === "billing_period") {
		const rows = await tx
			.select({
				period: billingPeriods,
				bucketId: usageBuckets.id,
				bucketCommittedUnits: usageBuckets.committedUnits,
			})
			.from(billingPeriods)
			.leftJoin(
				usageBuckets,
				and(
					eq(usageBuckets.billingPeriodId, billingPeriods.id),
					eq(usageBuckets.organizationId, billingPeriods.organizationId),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, organizationId),
					afterIdCondition(billingPeriods.id, afterId),
					sql`${billingPeriods.periodEnd} + INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(billingPeriods.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update", { of: billingPeriods });
		const carryovers = await getUsageCarryoverContributions(tx, {
			organizationId,
			successorBucketIds: rows.flatMap(({ bucketId }) =>
				bucketId ? [bucketId] : [],
			),
		});
		const unresolved = rows.find(
			({ bucketId }) =>
				bucketId !== null && (carryovers.get(bucketId)?.pendingUnits ?? 0) > 0,
		);
		if (unresolved?.bucketId) {
			throw new Error(
				`Usage carryover remains unresolved for bucket ${unresolved.bucketId}`,
			);
		}
		return {
			sourceIds: rows.map(({ period }) => period.id),
			candidates: rows.map(({ period, bucketId, bucketCommittedUnits }) => {
				const quantity =
					period.committedUnitsSnapshot ?? bucketCommittedUnits ?? 0;
				const included =
					period.effectiveIncludedUnitsSnapshot ??
					effectiveCarryoverAllowance(
						period.includedUnits,
						bucketId ? (carryovers.get(bucketId)?.committedUnits ?? 0) : 0,
					) ??
					0;
				return {
					sourceKind: source,
					sourceId: period.id,
					organizationTombstoneId: organizationId,
					retentionClass: "financial_7_years",
					status: billingPeriodReceiptStatus(period.state),
					periodStart: period.periodStart,
					periodEnd: period.periodEnd,
					amountCents: period.amountCentsSnapshot ?? 0,
					currency: period.currency,
					quantity,
					includedQuantity: included,
					overageQuantity:
						period.overageUnitsSnapshot ?? Math.max(0, quantity - included),
					providerReferences: [
						["billing_period", period.id],
						["stripe_invoice", period.stripeInvoiceId],
					],
					retentionAnchorAt:
						period.settledAt ??
						period.releasedAt ??
						period.claimedAt ??
						period.closedAt ??
						period.periodEnd,
				};
			}),
		};
	}

	if (source === "billing_operation") {
		const rows = await tx
			.select({
				operation: billingOperations,
				period: billingPeriods,
			})
			.from(billingOperations)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, billingOperations.billingPeriodId),
					eq(billingPeriods.organizationId, billingOperations.organizationId),
				),
			)
			.where(
				and(
					eq(billingOperations.organizationId, organizationId),
					afterIdCondition(billingOperations.id, afterId),
					sql`COALESCE(${billingOperations.completedAt}, ${billingOperations.updatedAt})
						+ INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(billingOperations.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update", { of: billingOperations });
		const attempts =
			rows.length === 0
				? []
				: await tx
						.select()
						.from(billingOperationAttempts)
						.where(
							inArray(
								billingOperationAttempts.billingOperationId,
								rows.map(({ operation }) => operation.id),
							),
						)
						.orderBy(
							asc(billingOperationAttempts.billingOperationId),
							asc(billingOperationAttempts.revision),
						)
						.for("share");
		const attemptsByOperation = groupBillingOperationAttempts(attempts);
		return {
			sourceIds: rows.map(({ operation }) => operation.id),
			candidates: rows.map(({ operation, period }) => ({
				sourceKind: source,
				sourceId: operation.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: operationReceiptStatus(operation.status),
				periodStart: period.periodStart,
				periodEnd: period.periodEnd,
				amountCents: operation.amountCents,
				currency: operation.currency,
				quantity: period.committedUnitsSnapshot ?? 0,
				providerReferences: billingOperationProviderReferences(
					operation,
					period,
					attemptsByOperation.get(operation.id) ?? [],
				),
				retentionAnchorAt: operation.completedAt ?? operation.updatedAt,
			})),
		};
	}

	if (source === "dunning_event") {
		const rows = await tx
			.select()
			.from(dunningEvents)
			.where(
				and(
					eq(dunningEvents.organizationId, organizationId),
					afterIdCondition(dunningEvents.id, afterId),
					sql`COALESCE(${dunningEvents.sentAt}, ${dunningEvents.updatedAt})
						+ INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(dunningEvents.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => ({
				sourceKind: source,
				sourceId: row.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: dunningReceiptStatus(row),
				providerReferences: [
					["stripe_invoice", row.stripeInvoiceId],
					["email_message", row.providerMessageId],
					["delivery_idempotency", row.deliveryIdempotencyKey],
					["deactivation_operation", row.deactivationOperationId],
				],
				retentionAnchorAt: row.sentAt ?? row.updatedAt,
			})),
		};
	}

	if (source === "checkout_operation") {
		const rows = await tx
			.select()
			.from(subscriptionCheckoutOperations)
			.where(
				and(
					eq(subscriptionCheckoutOperations.organizationId, organizationId),
					inArray(subscriptionCheckoutOperations.status, [
						"creating",
						"unknown",
					]),
					afterIdCondition(subscriptionCheckoutOperations.id, afterId),
					sql`${subscriptionCheckoutOperations.updatedAt}
						+ INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(subscriptionCheckoutOperations.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => ({
				sourceKind: source,
				sourceId: row.id,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: "unknown",
				providerReferences: [
					["stripe_customer", row.stripeCustomerId],
					["stripe_checkout_session", row.stripeCheckoutSessionId],
					["stripe_idempotency", row.idempotencyKey],
				],
				retentionAnchorAt: row.updatedAt,
			})),
		};
	}

	if (source === "billing_outbox") {
		const rows = await tx
			.select()
			.from(billingOutbox)
			.where(
				and(
					eq(billingOutbox.organizationId, organizationId),
					inArray(billingOutbox.status, [
						"pending",
						"processing",
						"failed",
						"manual_review",
					]),
					afterIdCondition(billingOutbox.id, afterId),
					sql`${billingOutbox.updatedAt} + INTERVAL '7 years' > ${now}`,
				),
			)
			.orderBy(asc(billingOutbox.id))
			.limit(FINANCIAL_RETENTION_BATCH_SIZE)
			.for("update");
		return {
			sourceIds: rows.map(({ id }) => id),
			candidates: rows.map((row) => {
				const payload =
					row.payload && typeof row.payload === "object"
						? (row.payload as Record<string, unknown>)
						: {};
				return {
					sourceKind: source,
					sourceId: row.id,
					organizationTombstoneId: organizationId,
					retentionClass: "financial_7_years",
					status: "manual_review",
					providerReferences: [
						[
							"stripe_subscription",
							typeof payload.stripeSubscriptionId === "string"
								? payload.stripeSubscriptionId
								: null,
						],
					],
					retentionAnchorAt: row.manualReviewAt ?? row.updatedAt,
				};
			}),
		};
	}

	// Discover candidates without holding the tenant row, then use the same
	// advisory -> Stripe row -> subscription lock order as the scheduled drain.
	// Revalidation below prevents a concurrent subscription replacement from
	// turning an observed provider ID into tenant attribution by convention.
	const [observedSubscription] = await tx
		.select({
			stripeCustomerId: organizationSubscriptions.stripeCustomerId,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);
	const legacyAttribution = or(
		observedSubscription?.stripeSubscriptionId
			? eq(
					stripeEvents.subscriptionId,
					observedSubscription.stripeSubscriptionId,
				)
			: undefined,
		observedSubscription?.stripeCustomerId
			? eq(stripeEvents.customerId, observedSubscription.stripeCustomerId)
			: undefined,
	);
	const attribution = or(
		eq(stripeEvents.organizationId, organizationId),
		legacyAttribution
			? and(isNull(stripeEvents.organizationId), legacyAttribution)
			: undefined,
	);
	const candidateIds = await tx
		.select({ id: stripeEvents.id })
		.from(stripeEvents)
		.where(attribution)
		.orderBy(asc(stripeEvents.receivedAt), asc(stripeEvents.id))
		.limit(FINANCIAL_RETENTION_BATCH_SIZE);
	const sourceDigests = new Map(
		await Promise.all(
			candidateIds.map(
				async ({ id }) =>
					[id, await digestFinancialExternalSourceId("stripe", id)] as const,
			),
		),
	);
	for (const sourceDigest of [...sourceDigests.values()].sort()) {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(
				hashtextextended(${financialStripeEventAdvisoryLockKey(sourceDigest)}, 0)
			)`,
		);
	}
	const lockedRows =
		candidateIds.length > 0
			? await tx
					.select()
					.from(stripeEvents)
					.where(
						inArray(
							stripeEvents.id,
							candidateIds.map(({ id }) => id),
						),
					)
					.orderBy(asc(stripeEvents.receivedAt), asc(stripeEvents.id))
					.for("update")
			: [];
	const [subscription] = await tx
		.select({
			stripeCustomerId: organizationSubscriptions.stripeCustomerId,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.for("update")
		.limit(1);
	const subscriptionChanged =
		(observedSubscription?.stripeCustomerId ?? null) !==
			(subscription?.stripeCustomerId ?? null) ||
		(observedSubscription?.stripeSubscriptionId ?? null) !==
			(subscription?.stripeSubscriptionId ?? null);
	const rows = lockedRows.filter(
		(row) =>
			row.organizationId === organizationId ||
			(row.organizationId === null &&
				Boolean(
					subscription &&
						((subscription.stripeSubscriptionId !== null &&
							row.subscriptionId === subscription.stripeSubscriptionId) ||
							(subscription.stripeCustomerId !== null &&
								row.customerId === subscription.stripeCustomerId)),
				)),
	);
	const candidates: ReceiptCandidate[] = [];
	for (const row of rows) {
		const sourceId = sourceDigests.get(row.id);
		if (!sourceId) {
			throw new Error("Tenant Stripe retention source digest is missing");
		}
		if (
			addUtcMonthsClamped(
				row.receivedAt,
				STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS * 12,
			) > now
		) {
			candidates.push({
				sourceKind: "stripe_event_global",
				sourceId,
				organizationTombstoneId: null,
				retentionClass: "provider_receipt_1_year",
				status: stripeReceiptStatus(row.status),
				providerReferences: [
					["stripe_event", row.id],
					["stripe_object", row.objectId],
					["stripe_customer", row.customerId],
					["stripe_subscription", row.subscriptionId],
				],
				retentionAnchorAt: row.receivedAt,
			});
		}
		if (
			(row.status === "failed" || row.status === "manual_review") &&
			addUtcMonthsClamped(
				row.receivedAt,
				FINANCIAL_INVOICE_RETENTION_YEARS * 12,
			) > now
		) {
			candidates.push({
				sourceKind: source,
				sourceId,
				organizationTombstoneId: organizationId,
				retentionClass: "financial_7_years",
				status: row.status === "manual_review" ? "manual_review" : "failed",
				providerReferences: [
					["stripe_event", row.id],
					["stripe_object", row.objectId],
					["stripe_customer", row.customerId],
					["stripe_subscription", row.subscriptionId],
				],
				retentionAnchorAt: row.receivedAt,
			});
		}
	}
	return {
		sourceIds: rows.map(({ id }) => id),
		candidates,
		stripeEventIdsToDelete: rows.map(({ id }) => id),
		repeatSource: subscriptionChanged,
	};
}

/**
 * Materialize one bounded, transactionally consistent page before the tenant
 * purge reaches any billing table. Stripe attribution uses only a locked
 * current subscription row and never guesses from unowned payload content.
 */
export async function materializeTenantFinancialRetentionBatch(
	db: Database,
	organizationId: string,
	cursor: TenantFinancialRetentionCursor = {},
	options?: { now?: Date },
): Promise<TenantFinancialRetentionBatchResult> {
	const now = options?.now ?? new Date();
	const sourceIndex = cursor.source_index ?? 0;
	if (!TENANT_FINANCIAL_SOURCES[sourceIndex]) {
		return { completed: true, cursor: null, receiptsWritten: 0 };
	}

	return db.transaction(async (tx) => {
		const {
			candidates,
			sourceIds,
			stripeEventIdsToDelete = [],
			repeatSource = false,
		} = await tenantSourceCandidates(
			tx,
			organizationId,
			sourceIndex,
			cursor,
			now,
		);
		const receiptsWritten = await writeReceiptCandidates(tx, candidates, now);
		if (stripeEventIdsToDelete.length > 0) {
			await tx
				.delete(stripeEvents)
				.where(inArray(stripeEvents.id, stripeEventIdsToDelete));
		}
		const pageFull = sourceIds.length === FINANCIAL_RETENTION_BATCH_SIZE;
		const source = TENANT_FINANCIAL_SOURCES[sourceIndex];

		if (
			source === "stripe_event_financial" &&
			(sourceIds.length > 0 || repeatSource)
		) {
			// The page is deleted transactionally, so repeat the same bounded
			// source until an empty scan proves no attributable raw event remains.
			return {
				completed: false,
				cursor: { source_index: sourceIndex },
				receiptsWritten,
			};
		}
		if (pageFull) {
			return {
				completed: false,
				cursor: {
					source_index: sourceIndex,
					after_id: sourceIds.at(-1),
				},
				receiptsWritten,
			};
		}

		const nextSourceIndex = sourceIndex + 1;
		return {
			completed: nextSourceIndex >= TENANT_FINANCIAL_SOURCES.length,
			cursor:
				nextSourceIndex >= TENANT_FINANCIAL_SOURCES.length
					? null
					: { source_index: nextSourceIndex },
			receiptsWritten,
		};
	});
}

function billingOutboxProviderReferences(
	payload: unknown,
): readonly ProviderReference[] {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return [];
	const record = payload as Record<string, unknown>;
	return [
		[
			"stripe_subscription",
			typeof record.stripeSubscriptionId === "string"
				? record.stripeSubscriptionId
				: null,
		],
	];
}

async function pruneCheckoutOperations(
	db: Database,
	now: Date,
	cutoff: Date,
): Promise<{ receipts: number; deleted: number }> {
	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(subscriptionCheckoutOperations)
				.where(
					and(
						lte(subscriptionCheckoutOperations.updatedAt, cutoff),
						or(
							inArray(subscriptionCheckoutOperations.status, [
								"pending",
								"creating",
								"unknown",
								"completed",
								"blocked",
								"failed",
								"expired",
							]),
							and(
								eq(subscriptionCheckoutOperations.status, "created"),
								lte(subscriptionCheckoutOperations.sessionExpiresAt, now),
							),
						),
					),
				)
				.orderBy(
					asc(subscriptionCheckoutOperations.updatedAt),
					asc(subscriptionCheckoutOperations.id),
				)
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { skipLocked: true });
			const uncertain = rows.filter((row) =>
				["creating", "unknown"].includes(row.status),
			);
			const written = await writeReceiptCandidates(
				tx,
				uncertain.map((row) => ({
					sourceKind: "checkout_operation",
					sourceId: row.id,
					organizationTombstoneId: row.organizationId,
					retentionClass: "financial_7_years",
					status: "unknown",
					providerReferences: [
						["stripe_customer", row.stripeCustomerId],
						["stripe_checkout_session", row.stripeCheckoutSessionId],
						["stripe_idempotency", row.idempotencyKey],
					],
					retentionAnchorAt: row.updatedAt,
				})),
				now,
			);
			if (rows.length > 0) {
				await tx.delete(subscriptionCheckoutOperations).where(
					inArray(
						subscriptionCheckoutOperations.id,
						rows.map(({ id }) => id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function pruneBillingOutbox(
	db: Database,
	now: Date,
	cutoff: Date,
): Promise<{ receipts: number; deleted: number }> {
	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(billingOutbox)
				.where(lte(billingOutbox.updatedAt, cutoff))
				.orderBy(asc(billingOutbox.updatedAt), asc(billingOutbox.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { skipLocked: true });
			const unresolved = rows.filter(({ status }) => status !== "succeeded");
			const written = await writeReceiptCandidates(
				tx,
				unresolved.map((row) => ({
					sourceKind: "billing_outbox",
					sourceId: row.id,
					organizationTombstoneId: row.organizationId,
					retentionClass: "financial_7_years",
					status: "manual_review",
					providerReferences: billingOutboxProviderReferences(row.payload),
					retentionAnchorAt: row.manualReviewAt ?? row.updatedAt,
				})),
				now,
			);
			if (rows.length > 0) {
				await tx.delete(billingOutbox).where(
					inArray(
						billingOutbox.id,
						rows.map(({ id }) => id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function pruneBillingOperations(
	db: Database,
	now: Date,
	cutoff: Date,
): Promise<{ receipts: number; deleted: number }> {
	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const rows = await tx
				.select({
					operation: billingOperations,
					period: billingPeriods,
				})
				.from(billingOperations)
				.innerJoin(
					billingPeriods,
					and(
						eq(billingPeriods.id, billingOperations.billingPeriodId),
						eq(billingPeriods.organizationId, billingOperations.organizationId),
					),
				)
				.where(
					and(
						lte(billingOperations.updatedAt, cutoff),
						sql`(
							COALESCE(${billingOperations.lastError}, '') NOT LIKE ${`${LATE_BILLING_EFFECT_ALERT_PREFIX}%`}
							OR COALESCE(${billingOperations.completedAt}, ${billingOperations.createdAt})
								+ INTERVAL '7 years' <= ${now}
						)`,
						inArray(billingOperations.status, [
							"succeeded",
							"released",
							"written_off",
						]),
					),
				)
				.orderBy(asc(billingOperations.updatedAt), asc(billingOperations.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { of: billingOperations, skipLocked: true });
			const attempts =
				rows.length === 0
					? []
					: await tx
							.select()
							.from(billingOperationAttempts)
							.where(
								inArray(
									billingOperationAttempts.billingOperationId,
									rows.map(({ operation }) => operation.id),
								),
							)
							.orderBy(
								asc(billingOperationAttempts.billingOperationId),
								asc(billingOperationAttempts.revision),
							)
							.for("update", {
								of: billingOperationAttempts,
							});
			const attemptsByOperation = groupBillingOperationAttempts(attempts);
			const written = await writeReceiptCandidates(
				tx,
				rows.map(({ operation, period }) => ({
					sourceKind: "billing_operation",
					sourceId: operation.id,
					organizationTombstoneId: operation.organizationId,
					retentionClass: "financial_7_years",
					status: operationReceiptStatus(operation.status),
					periodStart: period.periodStart,
					periodEnd: period.periodEnd,
					amountCents: operation.amountCents,
					currency: operation.currency,
					quantity: period.committedUnitsSnapshot ?? 0,
					providerReferences: billingOperationProviderReferences(
						operation,
						period,
						attemptsByOperation.get(operation.id) ?? [],
					),
					retentionAnchorAt: operation.completedAt ?? operation.updatedAt,
				})),
				now,
			);
			if (rows.length > 0) {
				await tx.delete(billingOperationAttempts).where(
					inArray(
						billingOperationAttempts.billingOperationId,
						rows.map(({ operation }) => operation.id),
					),
				);
				await tx.delete(billingOperations).where(
					inArray(
						billingOperations.id,
						rows.map(({ operation }) => operation.id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function pruneDunningEvents(
	db: Database,
	now: Date,
	cutoff: Date,
): Promise<{ receipts: number; deleted: number }> {
	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(dunningEvents)
				.where(lte(dunningEvents.updatedAt, cutoff))
				.orderBy(asc(dunningEvents.updatedAt), asc(dunningEvents.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { skipLocked: true });
			const written = await writeReceiptCandidates(
				tx,
				rows.map((row) => ({
					sourceKind: "dunning_event",
					sourceId: row.id,
					organizationTombstoneId: row.organizationId,
					retentionClass: "financial_7_years",
					status: dunningReceiptStatus(row),
					providerReferences: [
						["stripe_invoice", row.stripeInvoiceId],
						["email_message", row.providerMessageId],
						["delivery_idempotency", row.deliveryIdempotencyKey],
						["deactivation_operation", row.deactivationOperationId],
					],
					retentionAnchorAt: row.sentAt ?? row.updatedAt,
				})),
				now,
			);
			if (rows.length > 0) {
				await tx.delete(dunningEvents).where(
					inArray(
						dunningEvents.id,
						rows.map(({ id }) => id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function pruneBillingPeriods(
	db: Database,
	now: Date,
): Promise<{ receipts: number; deleted: number }> {
	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const rows = await tx
				.select({
					period: billingPeriods,
				})
				.from(billingPeriods)
				.where(
					and(
						sql`${billingPeriods.periodEnd} + INTERVAL '25 months' <= ${now}`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${billingOperations} AS operation
							WHERE operation.billing_period_id = ${billingPeriods.id}
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${usageBuckets} AS bucket
							WHERE bucket.billing_period_id = ${billingPeriods.id}
						)`,
					),
				)
				.orderBy(asc(billingPeriods.periodEnd), asc(billingPeriods.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { of: billingPeriods, skipLocked: true });
			const written = await writeReceiptCandidates(
				tx,
				rows.map(({ period }) => ({
					sourceKind: "billing_period",
					sourceId: period.id,
					organizationTombstoneId: period.organizationId,
					retentionClass: "financial_7_years",
					status: billingPeriodReceiptStatus(period.state),
					periodStart: period.periodStart,
					periodEnd: period.periodEnd,
					amountCents: period.amountCentsSnapshot ?? 0,
					currency: period.currency,
					quantity: period.committedUnitsSnapshot ?? 0,
					includedQuantity:
						period.effectiveIncludedUnitsSnapshot ?? period.includedUnits ?? 0,
					overageQuantity: period.overageUnitsSnapshot ?? 0,
					providerReferences: [
						["billing_period", period.id],
						["stripe_invoice", period.stripeInvoiceId],
					],
					retentionAnchorAt:
						period.settledAt ??
						period.releasedAt ??
						period.claimedAt ??
						period.closedAt ??
						period.periodEnd,
				})),
				now,
			);
			if (rows.length > 0) {
				await tx.delete(billingPeriods).where(
					inArray(
						billingPeriods.id,
						rows.map(({ period }) => period.id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function stripeAttributionByCurrentBillingState(
	tx: FinancialTransaction,
	rows: readonly (typeof stripeEvents.$inferSelect)[],
): Promise<Map<string, string>> {
	const durableAttribution = new Map(
		rows.flatMap((row) =>
			row.organizationId ? [[row.id, row.organizationId] as const] : [],
		),
	);
	const legacyRows = rows.filter((row) => row.organizationId === null);
	const subscriptionIds = [
		...new Set(
			legacyRows.flatMap(({ subscriptionId }) => subscriptionId ?? []),
		),
	];
	const customerIds = [
		...new Set(legacyRows.flatMap(({ customerId }) => customerId ?? [])),
	];
	if (subscriptionIds.length === 0 && customerIds.length === 0) {
		return durableAttribution;
	}
	const subscriptions = await tx
		.select({
			organizationId: organizationSubscriptions.organizationId,
			stripeCustomerId: organizationSubscriptions.stripeCustomerId,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
		})
		.from(organizationSubscriptions)
		.where(
			or(
				subscriptionIds.length > 0
					? inArray(
							organizationSubscriptions.stripeSubscriptionId,
							subscriptionIds,
						)
					: undefined,
				customerIds.length > 0
					? inArray(organizationSubscriptions.stripeCustomerId, customerIds)
					: undefined,
			),
		)
		.for("share");
	const bySubscription = new Map(
		subscriptions.flatMap((row) =>
			row.stripeSubscriptionId
				? [[row.stripeSubscriptionId, row.organizationId] as const]
				: [],
		),
	);
	const byCustomer = new Map(
		subscriptions.flatMap((row) =>
			row.stripeCustomerId
				? [[row.stripeCustomerId, row.organizationId] as const]
				: [],
		),
	);
	return new Map([
		...durableAttribution,
		...legacyRows.flatMap((row) => {
			const matches = new Set(
				[
					row.subscriptionId
						? bySubscription.get(row.subscriptionId)
						: undefined,
					row.customerId ? byCustomer.get(row.customerId) : undefined,
				].filter((value): value is string => Boolean(value)),
			);
			const organizationId = matches.size === 1 ? [...matches][0] : undefined;
			return organizationId ? [[row.id, organizationId] as const] : [];
		}),
	]);
}

async function pruneStripeEvents(
	db: Database,
	now: Date,
	cutoff: Date,
): Promise<{ receipts: number; deleted: number }> {
	// A successful handler already redacts synchronously. This bounded repair
	// closes crash/legacy gaps without waiting for the 90-day row drain.
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const repaired = await db
			.update(stripeEvents)
			.set({ payload: sql`'{}'::jsonb`, lastError: null, updatedAt: now })
			.where(
				inArray(
					stripeEvents.id,
					db
						.select({ id: stripeEvents.id })
						.from(stripeEvents)
						.where(
							and(
								eq(stripeEvents.status, "succeeded"),
								sql`${stripeEvents.payload} <> '{}'::jsonb`,
							),
						)
						.orderBy(asc(stripeEvents.receivedAt), asc(stripeEvents.id))
						.limit(FINANCIAL_RETENTION_BATCH_SIZE),
				),
			)
			.returning({ id: stripeEvents.id });
		if (repaired.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}

	let receipts = 0;
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const page = await db.transaction(async (tx) => {
			const candidateIds = await tx
				.select({ id: stripeEvents.id })
				.from(stripeEvents)
				.where(
					and(
						lte(stripeEvents.receivedAt, cutoff),
						or(
							eq(stripeEvents.status, "succeeded"),
							and(
								eq(stripeEvents.status, "failed"),
								eq(stripeEvents.lastErrorClass, "permanent"),
							),
						),
					),
				)
				.orderBy(asc(stripeEvents.receivedAt), asc(stripeEvents.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE);
			const sourceDigests = new Map(
				await Promise.all(
					candidateIds.map(
						async ({ id }) =>
							[
								id,
								await digestFinancialExternalSourceId("stripe", id),
							] as const,
					),
				),
			);
			for (const sourceDigest of [...sourceDigests.values()].sort()) {
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(
						hashtextextended(${financialStripeEventAdvisoryLockKey(sourceDigest)}, 0)
					)`,
				);
			}
			if (candidateIds.length === 0) {
				return { count: 0, written: 0 };
			}
			const rows = await tx
				.select()
				.from(stripeEvents)
				.where(
					and(
						inArray(
							stripeEvents.id,
							candidateIds.map(({ id }) => id),
						),
						lte(stripeEvents.receivedAt, cutoff),
						or(
							eq(stripeEvents.status, "succeeded"),
							and(
								eq(stripeEvents.status, "failed"),
								eq(stripeEvents.lastErrorClass, "permanent"),
							),
						),
					),
				)
				.orderBy(asc(stripeEvents.receivedAt), asc(stripeEvents.id))
				.for("update");
			const attribution = await stripeAttributionByCurrentBillingState(
				tx,
				rows,
			);
			const candidates: ReceiptCandidate[] = [];
			for (const row of rows) {
				const sourceId = sourceDigests.get(row.id);
				if (!sourceId) {
					throw new Error("Stripe retention source digest is missing");
				}
				if (
					addUtcMonthsClamped(
						row.receivedAt,
						STRIPE_GLOBAL_RECEIPT_RETENTION_YEARS * 12,
					) > now
				) {
					candidates.push({
						sourceKind: "stripe_event_global",
						sourceId,
						organizationTombstoneId: null,
						retentionClass: "provider_receipt_1_year",
						status: stripeReceiptStatus(row.status),
						providerReferences: [
							["stripe_event", row.id],
							["stripe_object", row.objectId],
							["stripe_customer", row.customerId],
							["stripe_subscription", row.subscriptionId],
						],
						retentionAnchorAt: row.receivedAt,
					});
				}
				const organizationId = attribution.get(row.id);
				if (
					organizationId &&
					(row.status === "failed" || row.status === "manual_review") &&
					addUtcMonthsClamped(
						row.receivedAt,
						FINANCIAL_INVOICE_RETENTION_YEARS * 12,
					) > now
				) {
					candidates.push({
						sourceKind: "stripe_event_financial",
						sourceId,
						organizationTombstoneId: organizationId,
						retentionClass: "financial_7_years",
						status: row.status === "manual_review" ? "manual_review" : "failed",
						providerReferences: [
							["stripe_event", row.id],
							["stripe_object", row.objectId],
							["stripe_customer", row.customerId],
							["stripe_subscription", row.subscriptionId],
						],
						retentionAnchorAt: row.receivedAt,
					});
				}
			}
			const written = await writeReceiptCandidates(tx, candidates, now);
			if (rows.length > 0) {
				await tx.delete(stripeEvents).where(
					inArray(
						stripeEvents.id,
						rows.map(({ id }) => id),
					),
				);
			}
			return { count: rows.length, written };
		});
		receipts += page.written;
		deleted += page.count;
		if (page.count < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return { receipts, deleted };
}

async function redactExpiredInvoiceUrls(
	db: Database,
	cutoff: Date,
): Promise<number> {
	let redacted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const rows = await db
			.update(invoices)
			.set({ stripeHostedUrl: null })
			.where(
				inArray(
					invoices.id,
					db
						.select({ id: invoices.id })
						.from(invoices)
						.where(
							and(
								isNotNull(invoices.stripeHostedUrl),
								sql`COALESCE(
										${invoices.paidAt},
										${invoices.finalizedAt},
										${invoices.periodEnd},
										${invoices.updatedAt}
									) <= ${cutoff}`,
							),
						)
						.orderBy(
							sql`COALESCE(
								${invoices.paidAt},
								${invoices.finalizedAt},
								${invoices.periodEnd},
								${invoices.updatedAt}
							)`,
							asc(invoices.id),
						)
						.limit(FINANCIAL_RETENTION_BATCH_SIZE),
				),
			)
			.returning({ id: invoices.id });
		redacted += rows.length;
		if (rows.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return redacted;
}

async function pruneExpiredUsageReservations(
	db: Database,
	now: Date,
): Promise<number> {
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const rows = await db.transaction(async (tx) => {
			// Usage finalization locks bucket -> reservation. Retention follows the
			// same order because deleting a reservation fires the bucket projection
			// trigger; reversing it can deadlock an old idempotent replay.
			const lockedBuckets = await tx
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(
					and(
						sql`${usageBuckets.periodEnd} + INTERVAL '25 months' <= ${now}`,
						sql`(
							${usageBuckets.billingPeriodId} IS NULL
							OR EXISTS (
								SELECT 1
								FROM ${billingPeriods} AS terminal_period
								WHERE terminal_period.id = ${usageBuckets.billingPeriodId}
								  AND terminal_period.organization_id = ${usageBuckets.organizationId}
								  AND terminal_period.state IN ('settled', 'released', 'void', 'written_off')
							)
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${erasureHolds} AS hold
							WHERE hold.subject_kind = 'organization'
							  AND hold.subject_id = ${usageBuckets.organizationId}
							  AND hold.organization_tombstone_id = ${usageBuckets.organizationId}
							  AND hold.released_at IS NULL
						)`,
						sql`EXISTS (
							SELECT 1
							FROM ${usageReservations} AS retention_candidate
							WHERE retention_candidate.bucket_id = ${usageBuckets.id}
							  AND retention_candidate.organization_id = ${usageBuckets.organizationId}
							  AND retention_candidate.state IN ('committed', 'released')
							  AND NOT EXISTS (
								SELECT 1
								FROM ${usageReservationCarryovers} AS carryover
								JOIN ${usageBuckets} AS successor_bucket
								  ON successor_bucket.id = carryover.successor_bucket_id
								 AND successor_bucket.organization_id = carryover.organization_id
								LEFT JOIN ${billingPeriods} AS successor_period
								  ON successor_period.id = successor_bucket.billing_period_id
								 AND successor_period.organization_id = successor_bucket.organization_id
								WHERE carryover.source_reservation_id = retention_candidate.id
								  AND (
									successor_bucket.billing_period_id IS NULL
									OR successor_period.id IS NULL
									OR NOT (
										successor_period.state = 'void'
										OR (
											successor_period.state IN ('claimed', 'settled', 'released', 'written_off')
											AND successor_period.effective_included_units_snapshot IS NOT NULL
										)
									)
								  )
							)
						)`,
					),
				)
				.orderBy(asc(usageBuckets.periodEnd), asc(usageBuckets.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { skipLocked: true });
			if (lockedBuckets.length === 0) return [];
			const lockedBucketIds = lockedBuckets.map(({ id }) => id);
			const reservations = await tx
				.select({ id: usageReservations.id })
				.from(usageReservations)
				.innerJoin(
					usageBuckets,
					and(
						eq(usageBuckets.id, usageReservations.bucketId),
						eq(usageBuckets.organizationId, usageReservations.organizationId),
					),
				)
				.where(
					and(
						inArray(usageReservations.bucketId, lockedBucketIds),
						inArray(usageReservations.state, ["committed", "released"]),
						sql`${usageBuckets.periodEnd} + INTERVAL '25 months' <= ${now}`,
						sql`(
							${usageBuckets.billingPeriodId} IS NULL
							OR EXISTS (
								SELECT 1
								FROM ${billingPeriods} AS terminal_period
								WHERE terminal_period.id = ${usageBuckets.billingPeriodId}
								  AND terminal_period.organization_id = ${usageBuckets.organizationId}
								  AND terminal_period.state IN ('settled', 'released', 'void', 'written_off')
							)
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${erasureHolds} AS hold
							WHERE hold.subject_kind = 'organization'
							  AND hold.subject_id = ${usageBuckets.organizationId}
							  AND hold.organization_tombstone_id = ${usageBuckets.organizationId}
							  AND hold.released_at IS NULL
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${usageReservationCarryovers} AS carryover
							JOIN ${usageBuckets} AS successor_bucket
							  ON successor_bucket.id = carryover.successor_bucket_id
							 AND successor_bucket.organization_id = carryover.organization_id
							LEFT JOIN ${billingPeriods} AS successor_period
							  ON successor_period.id = successor_bucket.billing_period_id
							 AND successor_period.organization_id = successor_bucket.organization_id
							WHERE carryover.source_reservation_id = ${usageReservations.id}
							  AND (
								successor_bucket.billing_period_id IS NULL
								OR successor_period.id IS NULL
								OR NOT (
									successor_period.state = 'void'
									OR (
										successor_period.state IN ('claimed', 'settled', 'released', 'written_off')
										AND successor_period.effective_included_units_snapshot IS NOT NULL
									)
								)
							  )
						)`,
					),
				)
				.orderBy(asc(usageReservations.bucketId), asc(usageReservations.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { of: usageReservations, skipLocked: true });
			if (reservations.length === 0) return [];
			const reservationIds = reservations.map(({ id }) => id);

			// These nullable links keep unresolved provider work pinned to its
			// financial provenance. Only terminal usage rows reach this point, and
			// all four detachments share the reservation lock and delete transaction.
			await tx
				.update(adCreationOperations)
				.set({ usageReservationId: null })
				.where(
					inArray(adCreationOperations.usageReservationId, reservationIds),
				);
			await tx
				.update(adMutationOperations)
				.set({ usageReservationId: null })
				.where(
					inArray(adMutationOperations.usageReservationId, reservationIds),
				);
			await tx
				.update(whatsappPhoneProvisioningOperations)
				.set({ provisioningUsageReservationId: null })
				.where(
					inArray(
						whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
						reservationIds,
					),
				);
			await tx
				.update(whatsappPhoneReleaseOperations)
				.set({ releaseUsageReservationId: null })
				.where(
					inArray(
						whatsappPhoneReleaseOperations.releaseUsageReservationId,
						reservationIds,
					),
				);

			return tx
				.delete(usageReservations)
				.where(inArray(usageReservations.id, reservationIds))
				.returning({ id: usageReservations.id });
		});
		deleted += rows.length;
		if (rows.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return deleted;
}

async function pruneExpiredUsageBuckets(
	db: Database,
	now: Date,
): Promise<number> {
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const rows = await db.transaction(async (tx) => {
			const buckets = await tx
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(
					and(
						sql`${usageBuckets.periodEnd} + INTERVAL '25 months' <= ${now}`,
						sql`(
							${usageBuckets.billingPeriodId} IS NULL
							OR EXISTS (
								SELECT 1
								FROM ${billingPeriods} AS terminal_period
								WHERE terminal_period.id = ${usageBuckets.billingPeriodId}
								  AND terminal_period.organization_id = ${usageBuckets.organizationId}
								  AND terminal_period.state IN ('settled', 'released', 'void', 'written_off')
							)
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${erasureHolds} AS hold
							WHERE hold.subject_kind = 'organization'
							  AND hold.subject_id = ${usageBuckets.organizationId}
							  AND hold.organization_tombstone_id = ${usageBuckets.organizationId}
							  AND hold.released_at IS NULL
						)`,
						sql`NOT EXISTS (
							SELECT 1
							FROM ${usageReservations} AS reservation
							WHERE reservation.bucket_id = ${usageBuckets.id}
						)`,
					),
				)
				.orderBy(asc(usageBuckets.periodEnd), asc(usageBuckets.id))
				.limit(FINANCIAL_RETENTION_BATCH_SIZE)
				.for("update", { skipLocked: true });
			if (buckets.length === 0) return [];
			return tx
				.delete(usageBuckets)
				.where(
					inArray(
						usageBuckets.id,
						buckets.map(({ id }) => id),
					),
				)
				.returning({ id: usageBuckets.id });
		});
		deleted += rows.length;
		if (rows.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return deleted;
}

async function pruneExpiredUsageDetail(
	db: Database,
	now: Date,
): Promise<number> {
	const reservations = await pruneExpiredUsageReservations(db, now);
	const buckets = await pruneExpiredUsageBuckets(db, now);
	return reservations + buckets;
}

async function pruneExpiredInvoices(db: Database, now: Date): Promise<number> {
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const rows = await db
			.delete(invoices)
			.where(
				inArray(
					invoices.id,
					db
						.select({ id: invoices.id })
						.from(invoices)
						.where(
							and(
								sql`COALESCE(
										${invoices.paidAt},
										${invoices.finalizedAt},
										${invoices.periodEnd},
										${invoices.updatedAt}
									) + INTERVAL '7 years' <= ${now}`,
								sql`NOT EXISTS (
									SELECT 1
									FROM ${erasureHolds} AS hold
									WHERE hold.subject_kind = 'organization'
									  AND hold.subject_id = ${invoices.organizationId}
									  AND hold.organization_tombstone_id = ${invoices.organizationId}
									  AND hold.released_at IS NULL
								)`,
								sql`NOT EXISTS (
									SELECT 1 FROM ${dunningEvents} AS dunning
									WHERE dunning.invoice_id = ${invoices.id}
								)`,
								sql`NOT EXISTS (
									SELECT 1 FROM ${billingPeriods} AS period
									WHERE period.invoice_id = ${invoices.id}
								)`,
							),
						)
						.orderBy(
							sql`COALESCE(
								${invoices.paidAt},
								${invoices.finalizedAt},
								${invoices.periodEnd},
								${invoices.updatedAt}
							)`,
							asc(invoices.id),
						)
						.limit(FINANCIAL_RETENTION_BATCH_SIZE),
				),
			)
			.returning({ id: invoices.id });
		deleted += rows.length;
		if (rows.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return deleted;
}

async function pruneExpiredFinancialReceipts(
	db: Database,
	now: Date,
): Promise<number> {
	let deleted = 0;
	for (let pass = 0; pass < FINANCIAL_RETENTION_MAX_PASSES; pass++) {
		const rows = await db
			.delete(financialRetentionReceipts)
			.where(
				inArray(
					financialRetentionReceipts.id,
					db
						.select({ id: financialRetentionReceipts.id })
						.from(financialRetentionReceipts)
						.where(
							and(
								lte(financialRetentionReceipts.retainedUntil, now),
								or(
									isNull(financialRetentionReceipts.organizationTombstoneId),
									sql`NOT EXISTS (
										SELECT 1
										FROM ${erasureHolds} AS hold
										WHERE hold.subject_kind = 'organization'
										  AND hold.subject_id = ${financialRetentionReceipts.organizationTombstoneId}
										  AND hold.organization_tombstone_id = ${financialRetentionReceipts.organizationTombstoneId}
										  AND hold.released_at IS NULL
									)`,
								),
							),
						)
						.orderBy(
							asc(financialRetentionReceipts.retainedUntil),
							asc(financialRetentionReceipts.id),
						)
						.limit(FINANCIAL_RETENTION_BATCH_SIZE),
				),
			)
			.returning({ id: financialRetentionReceipts.id });
		deleted += rows.length;
		if (rows.length < FINANCIAL_RETENTION_BATCH_SIZE) break;
	}
	return deleted;
}

/**
 * Daily, bounded financial retention. Holds pause only already-minimized
 * invoices, usage aggregates, and receipts; operational payloads, URLs,
 * customer references, errors, and provider responses still drain.
 */
export async function retainFinancialData(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<FinancialRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const operationalCutoff = new Date(
		now.getTime() - FINANCIAL_OPERATIONAL_RETENTION_DAYS * DAY_MS,
	);

	const hostedUrlsRedacted = await redactExpiredInvoiceUrls(
		db,
		operationalCutoff,
	);
	const stripe = await pruneStripeEvents(db, now, operationalCutoff);
	const checkout = await pruneCheckoutOperations(db, now, operationalCutoff);
	const outbox = await pruneBillingOutbox(db, now, operationalCutoff);
	// Child-first ordering preserves restrictive period/invoice FKs.
	const operations = await pruneBillingOperations(db, now, operationalCutoff);
	const dunning = await pruneDunningEvents(db, now, operationalCutoff);
	const usageRowsDeleted = await pruneExpiredUsageDetail(db, now);
	const periods = await pruneBillingPeriods(db, now);
	const invoicesDeleted = await pruneExpiredInvoices(db, now);
	const expiredReceiptsDeleted = await pruneExpiredFinancialReceipts(db, now);

	return {
		receiptsWritten:
			stripe.receipts +
			checkout.receipts +
			outbox.receipts +
			operations.receipts +
			dunning.receipts +
			periods.receipts,
		operationalRowsDeleted:
			stripe.deleted +
			checkout.deleted +
			outbox.deleted +
			operations.deleted +
			dunning.deleted +
			periods.deleted,
		hostedUrlsRedacted,
		usageRowsDeleted,
		invoicesDeleted,
		expiredReceiptsDeleted,
	};
}
