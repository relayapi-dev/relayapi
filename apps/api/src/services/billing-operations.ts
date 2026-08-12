import {
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
	createDb,
	type Database,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type Stripe from "stripe";
import type { Env } from "../types";
import { createStripeClient } from "./stripe";
import {
	assertStripeOrganizationFence,
	type StripeOrganizationFence,
} from "./stripe-organization-lease";

const LEASE_MS = 10 * 60 * 1000;
export const BILLING_OPERATION_MAX_ATTEMPTS = 160;
export const BILLING_OPERATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BILLING_OPERATION_MAX_BACKOFF_SECONDS = 6 * 60 * 60;

class ExactInvoiceTargetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExactInvoiceTargetError";
	}
}

class ClosedTargetInvoiceError extends ExactInvoiceTargetError {
	constructor(
		readonly stripeInvoiceId: string,
		readonly invoiceStatus: string,
	) {
		super(
			`Target Stripe invoice ${stripeInvoiceId} is ${invoiceStatus}, not draft`,
		);
		this.name = "ClosedTargetInvoiceError";
	}
}

class MissingBillingAttemptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissingBillingAttemptError";
	}
}

class StaleBillingOperationLeaseError extends Error {
	constructor() {
		super("Billing operation lease was superseded");
		this.name = "StaleBillingOperationLeaseError";
	}
}

type BillingOperation = typeof billingOperations.$inferSelect;
type BillingOperationAttempt = typeof billingOperationAttempts.$inferSelect;
type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ExactInvoiceTarget = Pick<
	BillingOperationAttempt,
	"stripeCustomerId" | "stripeSubscriptionId" | "stripeInvoiceId"
>;

export type ExactOverageBillingOperationScope = {
	operationId: string;
	organizationId: string;
	billingPeriodId: string;
	organizationFence: StripeOrganizationFence;
};

function assertExactOperationScope(
	scope: ExactOverageBillingOperationScope,
	operation?: BillingOperation,
): void {
	if (scope.organizationFence.organizationId !== scope.organizationId) {
		throw new Error(
			"Exact billing-operation scope disagrees with its organization fence",
		);
	}
	if (
		operation &&
		(operation.id !== scope.operationId ||
			operation.organizationId !== scope.organizationId ||
			operation.billingPeriodId !== scope.billingPeriodId)
	) {
		throw new Error(
			"Exact billing-operation scope selected another organization",
		);
	}
}

async function heartbeatExactOperationScope(
	db: Database | BillingTransaction,
	scope: ExactOverageBillingOperationScope | null,
	operation?: BillingOperation,
): Promise<void> {
	if (!scope) return;
	assertExactOperationScope(scope, operation);
	await assertStripeOrganizationFence(db, scope.organizationFence);
}

function stripeId(value: string | { id: string } | null | undefined) {
	return typeof value === "string" ? value : (value?.id ?? null);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	return stripeId(invoice.parent?.subscription_details?.subscription);
}

function invoiceItemSubscriptionId(item: Stripe.InvoiceItem): string | null {
	return item.parent?.subscription_details?.subscription ?? null;
}

function assertInvoiceItemTarget(
	item: Stripe.InvoiceItem,
	target: ExactInvoiceTarget,
): void {
	if (stripeId(item.invoice) !== target.stripeInvoiceId) {
		throw new ExactInvoiceTargetError(
			`Stripe invoice item ${item.id} did not attach to target invoice ${target.stripeInvoiceId}`,
		);
	}
	if (invoiceItemSubscriptionId(item) !== target.stripeSubscriptionId) {
		throw new ExactInvoiceTargetError(
			`Stripe invoice item ${item.id} did not retain target subscription ${target.stripeSubscriptionId}`,
		);
	}
}

async function assertDraftInvoiceTarget(
	stripe: Stripe,
	target: ExactInvoiceTarget,
): Promise<void> {
	const invoice = await stripe.invoices.retrieve(target.stripeInvoiceId);
	if (invoice.status !== "draft") {
		throw new ClosedTargetInvoiceError(
			invoice.id,
			invoice.status ?? "statusless",
		);
	}
	if (stripeId(invoice.customer) !== target.stripeCustomerId) {
		throw new ExactInvoiceTargetError(
			`Target Stripe invoice ${invoice.id} belongs to a different customer`,
		);
	}
	if (invoiceSubscriptionId(invoice) !== target.stripeSubscriptionId) {
		throw new ExactInvoiceTargetError(
			`Target Stripe invoice ${invoice.id} belongs to a different subscription`,
		);
	}
}

function assertCatchupInvoiceTarget(
	operation: BillingOperation,
	invoice: Stripe.Invoice,
): void {
	if (stripeId(invoice.customer) !== operation.stripeCustomerId) {
		throw new ExactInvoiceTargetError(
			`Catch-up Stripe invoice ${invoice.id} belongs to a different customer`,
		);
	}
	if (invoiceSubscriptionId(invoice) !== operation.stripeSubscriptionId) {
		throw new ExactInvoiceTargetError(
			`Catch-up Stripe invoice ${invoice.id} belongs to a different subscription`,
		);
	}
	if (
		invoice.metadata?.relayapi_operation_id !== operation.id ||
		invoice.metadata?.relayapi_operation_revision !==
			String(operation.attemptRevision) ||
		invoice.metadata?.billing_period_id !== operation.billingPeriodId ||
		invoice.metadata?.organization_id !== operation.organizationId ||
		invoice.metadata?.relayapi_operation_kind !== "catchup"
	) {
		throw new ExactInvoiceTargetError(
			`Catch-up Stripe invoice ${invoice.id} has mismatched operation metadata`,
		);
	}
}

async function ensureCatchupInvoiceFinalized(
	stripe: Stripe,
	operation: BillingOperation,
	attempt: BillingOperationAttempt,
): Promise<void> {
	if (operation.kind !== "catchup") return;
	let invoice = await stripe.invoices.retrieve(attempt.stripeInvoiceId);
	assertCatchupInvoiceTarget(operation, invoice);
	if (invoice.status === "draft") {
		invoice = await stripe.invoices.finalizeInvoice(
			invoice.id,
			{ auto_advance: true },
			{ idempotencyKey: `${attempt.idempotencyKey}:finalize` },
		);
		assertCatchupInvoiceTarget(operation, invoice);
	}
	if (invoice.status !== "open" && invoice.status !== "paid") {
		throw new ExactInvoiceTargetError(
			`Catch-up Stripe invoice ${invoice.id} finalized as ${invoice.status ?? "statusless"}`,
		);
	}
}

export function billingOperationNeedsManualReview(
	operation: { attempts: number; createdAt: Date },
	now: Date,
): "retry_exhausted" | "age_exhausted" | null {
	if (operation.attempts >= BILLING_OPERATION_MAX_ATTEMPTS) {
		return "retry_exhausted";
	}
	if (
		now.getTime() - operation.createdAt.getTime() >=
		BILLING_OPERATION_MAX_AGE_MS
	) {
		return "age_exhausted";
	}
	return null;
}

const AUTOMATIC_WRITE_OFF_POLICY = "ambiguous_stripe_outcome_30_day_horizon_v1";

async function writeOffCurrentAttempt(
	tx: BillingTransaction,
	operation: BillingOperation,
	writtenOffAt: Date,
): Promise<boolean> {
	let [attempt] = await tx
		.select()
		.from(billingOperationAttempts)
		.where(
			and(
				eq(billingOperationAttempts.billingOperationId, operation.id),
				eq(billingOperationAttempts.organizationId, operation.organizationId),
				eq(billingOperationAttempts.revision, operation.attemptRevision),
			),
		)
		.for("update")
		.limit(1);
	if (!attempt) return true;
	if (attempt.status === "succeeded") return false;
	if (attempt.status === "rejected" || attempt.status === "written_off") {
		return true;
	}
	if (attempt.status === "requesting") {
		[attempt] = await tx
			.update(billingOperationAttempts)
			.set({
				status: "unknown",
				providerEvidence: {
					outcome: "ambiguous",
					policy: AUTOMATIC_WRITE_OFF_POLICY,
				},
			})
			.where(
				and(
					eq(billingOperationAttempts.id, attempt.id),
					eq(billingOperationAttempts.status, "requesting"),
				),
			)
			.returning();
		if (!attempt) throw new StaleBillingOperationLeaseError();
	}
	if (attempt.status !== "prepared" && attempt.status !== "unknown") {
		return false;
	}
	const [writtenOff] = await tx
		.update(billingOperationAttempts)
		.set({
			status: "written_off",
			providerEvidence: {
				schema_version: 1,
				policy: AUTOMATIC_WRITE_OFF_POLICY,
				decision: "write_off_without_additional_stripe_mutation",
				owner: "billing_operation_recovery",
				operation_id: operation.id,
				attempt_revision: attempt.revision,
				prior_status: attempt.status,
				request_boundary_at:
					attempt.requestMayHaveBeenSentAt?.toISOString() ?? null,
				prior_provider_evidence: attempt.providerEvidence,
				written_off_at: writtenOffAt.toISOString(),
			},
			resolvedAt: writtenOffAt,
		})
		.where(
			and(
				eq(billingOperationAttempts.id, attempt.id),
				inArray(billingOperationAttempts.status, ["prepared", "unknown"]),
			),
		)
		.returning({ id: billingOperationAttempts.id });
	if (!writtenOff) throw new StaleBillingOperationLeaseError();
	return true;
}

async function writeOffAgedBillingOperation(
	db: Database,
	candidate: BillingOperation,
	now: Date,
): Promise<boolean> {
	const ageCutoff = new Date(now.getTime() - BILLING_OPERATION_MAX_AGE_MS);
	return db.transaction(async (tx) => {
		const [operation] = await tx
			.select()
			.from(billingOperations)
			.where(eq(billingOperations.id, candidate.id))
			.for("update")
			.limit(1);
		const freshOperatorRevision =
			operation &&
			operation.attemptRevision > 1 &&
			operation.attempts <= 1 &&
			["invoice_preparing", "invoice_unknown", "pending"].includes(
				operation.status,
			);
		if (
			!operation ||
			operation.createdAt > ageCutoff ||
			freshOperatorRevision ||
			operation.operatorRetryRequestedAt ||
			![
				"invoice_preparing",
				"invoice_unknown",
				"pending",
				"failed",
				"unknown",
				"processing",
			].includes(operation.status) ||
			(operation.status === "processing" &&
				operation.leaseExpiresAt &&
				operation.leaseExpiresAt > now)
		) {
			return false;
		}
		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, operation.billingPeriodId),
					eq(billingPeriods.organizationId, operation.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (period?.state !== "claimed") return false;
		if (!(await writeOffCurrentAttempt(tx, operation, now))) return false;

		const [writtenOffOperation] = await tx
			.update(billingOperations)
			.set({
				status: "written_off",
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				leaseExpiresAt: null,
				lastError:
					"Automatic recovery horizon exhausted; ambiguous Stripe outcome written off",
				lastErrorClass: "age_exhausted",
				operatorRetryRequestedAt: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.leaseToken, operation.leaseToken),
					eq(billingOperations.status, operation.status),
				),
			)
			.returning({ id: billingOperations.id });
		if (!writtenOffOperation) throw new StaleBillingOperationLeaseError();

		const [writtenOffPeriod] = await tx
			.update(billingPeriods)
			.set({
				state: "written_off",
				writtenOffAt: now,
				writeOffReason:
					"automatic_ambiguous_stripe_outcome_recovery_horizon_exhausted",
				writeOffEvidence: {
					schema_version: 1,
					policy: AUTOMATIC_WRITE_OFF_POLICY,
					decision: "write_off_without_additional_stripe_mutation",
					owner: "billing_operation_recovery",
					billing_operation_id: operation.id,
					billing_operation_kind: operation.kind,
					attempt_revision: operation.attemptRevision,
					amount_cents: operation.amountCents,
					currency: operation.currency,
					operation_created_at: operation.createdAt.toISOString(),
					written_off_at: now.toISOString(),
				},
			})
			.where(
				and(
					eq(billingPeriods.id, period.id),
					eq(billingPeriods.state, "claimed"),
				),
			)
			.returning({ id: billingPeriods.id });
		if (!writtenOffPeriod) throw new StaleBillingOperationLeaseError();
		return true;
	});
}

async function writeOffAgedBillingOperations(
	db: Database,
	statuses: BillingOperation["status"][],
	now: Date,
	limit = 100,
): Promise<number> {
	const ageCutoff = new Date(now.getTime() - BILLING_OPERATION_MAX_AGE_MS);
	const candidates = await db
		.select()
		.from(billingOperations)
		.where(
			and(
				inArray(billingOperations.status, statuses),
				isNull(billingOperations.operatorRetryRequestedAt),
				lte(billingOperations.createdAt, ageCutoff),
				or(
					sql`${billingOperations.status} <> 'processing'`,
					lte(billingOperations.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(billingOperations.createdAt), asc(billingOperations.id))
		.limit(limit);
	let writtenOff = 0;
	for (const candidate of candidates) {
		if (await writeOffAgedBillingOperation(db, candidate, now)) writtenOff++;
	}
	return writtenOff;
}

async function findStripeInvoiceItem(
	stripe: Stripe,
	operation: BillingOperation,
	attempt: BillingOperationAttempt,
): Promise<Stripe.InvoiceItem | null> {
	// Stripe may prune idempotency keys after 24 hours. Reconcile within the
	// immutable target invoice, never across all pending items for a customer.
	const items = stripe.invoiceItems.list({
		invoice: attempt.stripeInvoiceId,
		limit: 100,
	});
	for await (const item of items) {
		if (
			item.metadata?.relayapi_operation_id === operation.id &&
			item.metadata?.relayapi_operation_revision === String(attempt.revision)
		) {
			assertInvoiceItemTarget(item, attempt);
			return item;
		}
	}
	return null;
}

async function markSucceeded(
	db: Database,
	operation: BillingOperation,
	attempt: BillingOperationAttempt,
	invoiceItem: Stripe.InvoiceItem,
	reconciled: boolean,
	exactScope: ExactOverageBillingOperationScope | null,
): Promise<boolean> {
	const completedAt = new Date();
	return db.transaction(async (tx) => {
		await heartbeatExactOperationScope(tx, exactScope, operation);
		if (attempt.status !== "succeeded") {
			const transitioned = await tx
				.update(billingOperationAttempts)
				.set({
					status: "succeeded",
					stripeInvoiceItemId: invoiceItem.id,
					providerEvidence: {
						stripeInvoiceItemId: invoiceItem.id,
						stripeInvoiceId: stripeId(invoiceItem.invoice),
						stripeSubscriptionId: invoiceItemSubscriptionId(invoiceItem),
						reconciled,
					},
					resolvedAt: completedAt,
				})
				.where(
					and(
						eq(billingOperationAttempts.id, attempt.id),
						eq(billingOperationAttempts.billingOperationId, operation.id),
						eq(
							billingOperationAttempts.organizationId,
							operation.organizationId,
						),
						eq(billingOperationAttempts.revision, attempt.revision),
						inArray(billingOperationAttempts.status, ["requesting", "unknown"]),
					),
				)
				.returning({ id: billingOperationAttempts.id });
			if (transitioned.length === 0) return false;
		}
		const [completed] = await tx
			.update(billingOperations)
			.set({
				status: "succeeded",
				stripeInvoiceItemId: invoiceItem.id,
				leaseExpiresAt: null,
				lastError: null,
				lastErrorClass: null,
				operatorRetryRequestedAt: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, operation.organizationId),
					eq(billingOperations.billingPeriodId, operation.billingPeriodId),
					eq(billingOperations.status, "processing"),
					eq(billingOperations.leaseToken, operation.leaseToken),
					eq(billingOperations.attemptRevision, attempt.revision),
				),
			)
			.returning({ id: billingOperations.id });
		if (!completed) {
			throw new StaleBillingOperationLeaseError();
		}
		return true;
	});
}

async function markAttemptRequesting(
	db: Database,
	operation: BillingOperation,
	attempt: BillingOperationAttempt,
): Promise<BillingOperationAttempt | null> {
	if (attempt.status === "requesting") return attempt;
	const requestedAt = new Date();
	const [requesting] = await db
		.update(billingOperationAttempts)
		.set({
			status: "requesting",
			requestMayHaveBeenSentAt: sql`COALESCE(${billingOperationAttempts.requestMayHaveBeenSentAt}, ${requestedAt})`,
		})
		.where(
			and(
				eq(billingOperationAttempts.id, attempt.id),
				eq(billingOperationAttempts.billingOperationId, operation.id),
				eq(billingOperationAttempts.organizationId, operation.organizationId),
				eq(billingOperationAttempts.revision, operation.attemptRevision),
				inArray(billingOperationAttempts.status, ["prepared", "unknown"]),
				sql`EXISTS (
					SELECT 1
					  FROM ${billingOperations} AS parent_operation
					 WHERE parent_operation.id = ${operation.id}
					   AND parent_operation.organization_id = ${operation.organizationId}
					   AND parent_operation.billing_period_id = ${operation.billingPeriodId}
					   AND parent_operation.status = 'processing'
					   AND parent_operation.lease_token = ${operation.leaseToken}
					   AND parent_operation.attempt_revision = ${operation.attemptRevision}
				)`,
			),
		)
		.returning();
	return requesting ?? null;
}

async function reviseClosedInvoiceAsCatchup(
	db: Database,
	operation: BillingOperation,
	attempt: BillingOperationAttempt,
	error: ClosedTargetInvoiceError,
	exactScope: ExactOverageBillingOperationScope | null,
): Promise<boolean> {
	if (attempt.status !== "prepared" && attempt.status !== "requesting") {
		return false;
	}
	const revisedAt = new Date();
	const nextRevision = operation.attemptRevision + 1;
	const policy =
		attempt.status === "prepared"
			? "canonical_closed_invoice_before_request_v1"
			: "canonical_closed_invoice_rejected_request_absent_v1";
	return db.transaction(async (tx) => {
		await heartbeatExactOperationScope(tx, exactScope, operation);
		const [rejectedAttempt] = await tx
			.update(billingOperationAttempts)
			.set({
				status: "rejected",
				providerEvidence: {
					schema_version: 1,
					policy,
					decision: "provider_effect_not_applied",
					stripe_invoice_id: error.stripeInvoiceId,
					stripe_invoice_status: error.invoiceStatus,
					observed_at: revisedAt.toISOString(),
				},
				resolvedAt: revisedAt,
			})
			.where(
				and(
					eq(billingOperationAttempts.id, attempt.id),
					eq(billingOperationAttempts.billingOperationId, operation.id),
					eq(billingOperationAttempts.organizationId, operation.organizationId),
					eq(billingOperationAttempts.revision, operation.attemptRevision),
					eq(billingOperationAttempts.status, attempt.status),
				),
			)
			.returning({ id: billingOperationAttempts.id });
		if (!rejectedAttempt) return false;

		const [revisedOperation] = await tx
			.update(billingOperations)
			.set({
				kind: "catchup",
				status: "invoice_preparing",
				stripeInvoiceId: null,
				stripeInvoiceItemId: null,
				invoiceIdempotencyKey: `relayapi:overage:${operation.billingPeriodId}:catchup-invoice:r${nextRevision}`,
				idempotencyKey: `relayapi:overage:${operation.billingPeriodId}:catchup:r${nextRevision}`,
				attemptRevision: nextRevision,
				attempts: 0,
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				nextAttemptAt: revisedAt,
				leaseExpiresAt: null,
				lastError:
					attempt.status === "prepared"
						? "The exact renewal invoice closed before the item request boundary; preparing a catch-up revision"
						: "Stripe rejected the exact item after the renewal invoice closed; absence was reconciled and a catch-up revision is being prepared",
				lastErrorClass: null,
				operatorRetryRequestedAt: null,
				completedAt: null,
				updatedAt: revisedAt,
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, operation.organizationId),
					eq(billingOperations.billingPeriodId, operation.billingPeriodId),
					eq(billingOperations.kind, operation.kind),
					eq(billingOperations.status, "processing"),
					eq(billingOperations.leaseToken, operation.leaseToken),
					eq(billingOperations.attemptRevision, attempt.revision),
				),
			)
			.returning({ id: billingOperations.id });
		if (!revisedOperation) throw new StaleBillingOperationLeaseError();
		return true;
	});
}

async function markFailed(
	db: Database,
	operation: BillingOperation,
	attempt: BillingOperationAttempt | null,
	input: {
		message: string;
		statusCode?: number;
		terminal: boolean;
		manualReview: boolean;
		errorClass:
			| "unknown"
			| "transient"
			| "permanent"
			| "retry_exhausted"
			| "age_exhausted";
		requestStaged: boolean;
		ambiguous: boolean;
	},
	exactScope: ExactOverageBillingOperationScope | null,
): Promise<void> {
	const completedAt = new Date();
	await db.transaction(async (tx) => {
		await heartbeatExactOperationScope(tx, exactScope, operation);
		if (attempt && input.requestStaged) {
			const attemptStatus = input.terminal ? "rejected" : "unknown";
			const transitioned = await tx
				.update(billingOperationAttempts)
				.set({
					status: attemptStatus,
					providerEvidence: {
						outcome: input.terminal ? "rejected" : "ambiguous",
						statusCode: input.statusCode ?? null,
					},
					resolvedAt: input.terminal ? completedAt : null,
				})
				.where(
					and(
						eq(billingOperationAttempts.id, attempt.id),
						eq(billingOperationAttempts.billingOperationId, operation.id),
						eq(
							billingOperationAttempts.organizationId,
							operation.organizationId,
						),
						eq(billingOperationAttempts.revision, attempt.revision),
						eq(billingOperationAttempts.status, "requesting"),
					),
				)
				.returning({ id: billingOperationAttempts.id });
			if (transitioned.length === 0) {
				throw new Error("Billing attempt state was superseded");
			}
		}

		const parentStatus = input.terminal
			? "terminal_failed"
			: input.manualReview
				? "manual_review"
				: input.ambiguous
					? "unknown"
					: "failed";
		const transitioned = await tx
			.update(billingOperations)
			.set({
				status: parentStatus,
				nextAttemptAt: new Date(
					completedAt.getTime() +
						Math.min(
							BILLING_OPERATION_MAX_BACKOFF_SECONDS,
							2 ** Math.min(operation.attempts, 15),
						) *
							1000,
				),
				leaseExpiresAt: null,
				lastError: input.message,
				lastErrorClass: input.errorClass,
				completedAt: input.terminal || input.manualReview ? completedAt : null,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, operation.organizationId),
					eq(billingOperations.billingPeriodId, operation.billingPeriodId),
					eq(billingOperations.status, "processing"),
					eq(billingOperations.leaseToken, operation.leaseToken),
					eq(billingOperations.attemptRevision, operation.attemptRevision),
				),
			)
			.returning({ id: billingOperations.id });
		if (transitioned.length === 0) {
			throw new StaleBillingOperationLeaseError();
		}
	});
}

async function findCatchupInvoice(
	stripe: Stripe,
	operation: BillingOperation,
): Promise<Stripe.Invoice | null> {
	const invoices = stripe.invoices.list({
		customer: operation.stripeCustomerId,
		created: {
			gte: Math.max(0, Math.floor(operation.createdAt.getTime() / 1000) - 300),
		},
		limit: 100,
	});
	for await (const invoice of invoices) {
		if (
			invoice.metadata?.relayapi_operation_id !== operation.id ||
			invoice.metadata?.relayapi_operation_revision !==
				String(operation.attemptRevision)
		) {
			continue;
		}
		assertCatchupInvoiceTarget(operation, invoice);
		return invoice;
	}
	return null;
}

async function activateCatchupInvoice(
	db: Database,
	operation: BillingOperation,
	invoice: Stripe.Invoice,
): Promise<boolean> {
	assertCatchupInvoiceTarget(operation, invoice);
	if (invoice.status !== "draft") {
		throw new ExactInvoiceTargetError(
			`Catch-up invoice ${invoice.id} is ${invoice.status ?? "statusless"} before its overage item was attached`,
		);
	}
	return db.transaction(async (tx) => {
		const [activated] = await tx
			.update(billingOperations)
			.set({
				status: "pending",
				// Invoice discovery/creation and item attachment have independent
				// recovery budgets.  Carrying the invoice-phase claim count into the
				// item phase can make an aged, operator-revised operation immediately
				// eligible for write-off after its exact draft invoice was recovered.
				attempts: 0,
				stripeInvoiceId: invoice.id,
				nextAttemptAt: new Date(),
				leaseExpiresAt: null,
				lastError: null,
				lastErrorClass: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, operation.organizationId),
					eq(billingOperations.kind, "catchup"),
					eq(billingOperations.status, "invoice_unknown"),
					eq(billingOperations.leaseToken, operation.leaseToken),
					isNull(billingOperations.stripeInvoiceId),
				),
			)
			.returning({ id: billingOperations.id });
		if (!activated) return false;
		await tx.insert(billingOperationAttempts).values({
			id: `boa_${operation.billingPeriodId}_catchup_r${operation.attemptRevision}`,
			organizationId: operation.organizationId,
			billingOperationId: operation.id,
			revision: operation.attemptRevision,
			status: "prepared",
			stripeCustomerId: operation.stripeCustomerId,
			stripeSubscriptionId: operation.stripeSubscriptionId,
			stripeInvoiceId: invoice.id,
			idempotencyKey: operation.idempotencyKey,
			amountCents: operation.amountCents,
			currency: operation.currency,
			description: operation.description,
		});
		return true;
	});
}

/**
 * Create or reconcile standalone catch-up invoices without ever exposing
 * customer-level pending items. The operation is durably moved to
 * `invoice_unknown` before Stripe can receive the request; retries first scan
 * provider metadata and then reuse the same invoice idempotency key.
 */
export async function processCatchupInvoiceOperations(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	stripe?: Stripe,
	limit = 25,
): Promise<number> {
	const client = stripe ?? (await createStripeClient(env.STRIPE_SECRET_KEY));
	const now = new Date();
	const ageCutoff = new Date(now.getTime() - BILLING_OPERATION_MAX_AGE_MS);
	await writeOffAgedBillingOperations(
		db,
		["invoice_preparing", "invoice_unknown"],
		now,
	);
	await db
		.update(billingOperations)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			lastError: sql`COALESCE(${billingOperations.lastError}, 'Catch-up invoice creation exhausted its automatic attempt budget')`,
			lastErrorClass: "retry_exhausted",
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(billingOperations.kind, "catchup"),
				inArray(billingOperations.status, [
					"invoice_preparing",
					"invoice_unknown",
				]),
				sql`${billingOperations.attempts} >= ${BILLING_OPERATION_MAX_ATTEMPTS}`,
			),
		);
	const operations = await db
		.select()
		.from(billingOperations)
		.where(
			and(
				eq(billingOperations.kind, "catchup"),
				inArray(billingOperations.status, [
					"invoice_preparing",
					"invoice_unknown",
				]),
				lte(billingOperations.nextAttemptAt, now),
				sql`${billingOperations.attempts} < ${BILLING_OPERATION_MAX_ATTEMPTS}`,
				or(
					sql`${billingOperations.createdAt} > ${ageCutoff}`,
					and(
						sql`${billingOperations.attemptRevision} > 1`,
						sql`${billingOperations.attempts} <= 1`,
					),
				),
			),
		)
		.orderBy(
			asc(billingOperations.nextAttemptAt),
			asc(billingOperations.createdAt),
			asc(billingOperations.id),
		)
		.limit(limit);

	let activated = 0;
	for (const candidate of operations) {
		const claimNow = new Date();
		const [operation] = await db
			.update(billingOperations)
			.set({
				status: "invoice_unknown",
				attempts: sql`${billingOperations.attempts} + 1`,
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				// invoice_unknown cannot carry lease_expires_at by schema. Moving the
				// due time forward is the claim CAS; leaseToken fences its completion.
				nextAttemptAt: new Date(claimNow.getTime() + LEASE_MS),
				lastError: null,
				lastErrorClass: null,
				updatedAt: claimNow,
			})
			.where(
				and(
					eq(billingOperations.id, candidate.id),
					eq(billingOperations.kind, "catchup"),
					inArray(billingOperations.status, [
						"invoice_preparing",
						"invoice_unknown",
					]),
					isNull(billingOperations.stripeInvoiceId),
					lte(billingOperations.nextAttemptAt, claimNow),
					sql`${billingOperations.attempts} < ${BILLING_OPERATION_MAX_ATTEMPTS}`,
					or(
						sql`${billingOperations.createdAt} > ${ageCutoff}`,
						and(
							sql`${billingOperations.attemptRevision} > 1`,
							sql`${billingOperations.attempts} <= 1`,
						),
					),
				),
			)
			.returning();
		if (!operation) continue;
		try {
			if (!operation.invoiceIdempotencyKey) {
				throw new ExactInvoiceTargetError(
					`Catch-up operation ${operation.id} has no invoice idempotency key`,
				);
			}
			const existing = await findCatchupInvoice(client, operation);
			if (existing) {
				if (await activateCatchupInvoice(db, operation, existing)) activated++;
				continue;
			}

			const invoice = await client.invoices.create(
				{
					customer: operation.stripeCustomerId,
					subscription: operation.stripeSubscriptionId,
					currency: operation.currency,
					auto_advance: false,
					automatic_tax: { enabled: false },
					collection_method: "charge_automatically",
					discounts: [],
					pending_invoice_items_behavior: "exclude",
					metadata: {
						relayapi_operation_id: operation.id,
						relayapi_operation_kind: "catchup",
						relayapi_operation_revision: String(operation.attemptRevision),
						billing_period_id: operation.billingPeriodId,
						organization_id: operation.organizationId,
						stripe_subscription_id: operation.stripeSubscriptionId,
						stripe_price_role: "base",
					},
				},
				{ idempotencyKey: operation.invoiceIdempotencyKey },
			);
			if (await activateCatchupInvoice(db, operation, invoice)) activated++;
		} catch (error) {
			const statusCode =
				error && typeof error === "object" && "statusCode" in error
					? (error as { statusCode?: number }).statusCode
					: undefined;
			const permanent = Boolean(
				statusCode &&
					statusCode >= 400 &&
					statusCode < 500 &&
					statusCode !== 409 &&
					statusCode !== 429,
			);
			const failedAt = new Date();
			await db
				.update(billingOperations)
				.set({
					status: permanent ? "manual_review" : "invoice_unknown",
					leaseExpiresAt: null,
					nextAttemptAt: new Date(
						failedAt.getTime() +
							Math.min(
								BILLING_OPERATION_MAX_BACKOFF_SECONDS,
								2 ** Math.min(operation.attempts + 1, 15),
							) *
								1000,
					),
					lastError: error instanceof Error ? error.message : String(error),
					lastErrorClass: permanent ? "permanent" : "unknown",
					completedAt: permanent ? failedAt : null,
					updatedAt: failedAt,
				})
				.where(
					and(
						eq(billingOperations.id, operation.id),
						eq(billingOperations.status, "invoice_unknown"),
						eq(billingOperations.leaseToken, operation.leaseToken),
						isNull(billingOperations.stripeInvoiceId),
					),
				);
		}
	}
	return activated;
}

/**
 * Process durable overage mutations. Unknown provider outcomes are reconciled
 * by metadata before retrying, rather than assuming Stripe still retains the
 * request idempotency key.
 */
async function processOverageBillingOperationsInternal(
	env: Env,
	db: Database,
	stripe: Stripe | undefined,
	limit: number,
	exactScope: ExactOverageBillingOperationScope | null,
): Promise<number> {
	const client = stripe ?? (await createStripeClient(env.STRIPE_SECRET_KEY));
	const now = new Date();
	const ageCutoff = new Date(now.getTime() - BILLING_OPERATION_MAX_AGE_MS);
	if (exactScope) {
		await heartbeatExactOperationScope(db, exactScope);
	} else {
		await writeOffAgedBillingOperations(
			db,
			["pending", "failed", "unknown", "processing"],
			now,
		);
		await db
			.update(billingOperations)
			.set({
				status: "manual_review",
				leaseExpiresAt: null,
				lastError: sql`COALESCE(${billingOperations.lastError}, 'Billing operation exhausted its automatic attempt budget')`,
				lastErrorClass: "retry_exhausted",
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					isNull(billingOperations.operatorRetryRequestedAt),
					or(
						inArray(billingOperations.status, ["pending", "failed", "unknown"]),
						and(
							eq(billingOperations.status, "processing"),
							lte(billingOperations.leaseExpiresAt, now),
						),
					),
					sql`${billingOperations.attempts} >= ${BILLING_OPERATION_MAX_ATTEMPTS}`,
				),
			);
	}
	const candidates = await db
		.select()
		.from(billingOperations)
		.where(
			and(
				...(exactScope
					? [
							eq(billingOperations.id, exactScope.operationId),
							eq(billingOperations.organizationId, exactScope.organizationId),
							eq(billingOperations.billingPeriodId, exactScope.billingPeriodId),
						]
					: []),
				or(
					and(
						inArray(billingOperations.status, ["pending", "failed", "unknown"]),
						lte(billingOperations.nextAttemptAt, now),
					),
					and(
						eq(billingOperations.status, "processing"),
						lte(billingOperations.leaseExpiresAt, now),
					),
				),
				sql`${billingOperations.attempts} < ${BILLING_OPERATION_MAX_ATTEMPTS}`,
				or(
					sql`${billingOperations.createdAt} > ${ageCutoff}`,
					isNotNull(billingOperations.operatorRetryRequestedAt),
					and(
						sql`${billingOperations.attemptRevision} > 1`,
						sql`${billingOperations.attempts} <= 1`,
					),
				),
			),
		)
		.orderBy(
			asc(billingOperations.nextAttemptAt),
			asc(billingOperations.createdAt),
		)
		.limit(exactScope ? 1 : limit);

	let succeeded = 0;
	for (const candidate of candidates) {
		if (exactScope) assertExactOperationScope(exactScope, candidate);
		const claimNow = new Date();
		const [claimed] = await db
			.update(billingOperations)
			.set({
				status: "processing",
				attempts: sql`${billingOperations.attempts} + 1`,
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimNow.getTime() + LEASE_MS),
				operatorRetryRequestedAt: null,
				updatedAt: claimNow,
			})
			.where(
				and(
					eq(billingOperations.id, candidate.id),
					eq(billingOperations.organizationId, candidate.organizationId),
					eq(billingOperations.billingPeriodId, candidate.billingPeriodId),
					sql`${billingOperations.attempts} < ${BILLING_OPERATION_MAX_ATTEMPTS}`,
					or(
						sql`${billingOperations.createdAt} > ${ageCutoff}`,
						isNotNull(billingOperations.operatorRetryRequestedAt),
						and(
							sql`${billingOperations.attemptRevision} > 1`,
							sql`${billingOperations.attempts} <= 1`,
						),
					),
					or(
						and(
							inArray(billingOperations.status, [
								"pending",
								"failed",
								"unknown",
							]),
							lte(billingOperations.nextAttemptAt, claimNow),
						),
						and(
							eq(billingOperations.status, "processing"),
							lte(billingOperations.leaseExpiresAt, claimNow),
						),
					),
				),
			)
			.returning();
		if (!claimed) continue;

		let durableAttempt: BillingOperationAttempt | null = null;
		let requestStaged = false;
		let createAttempted = false;
		let providerEffectExists = false;
		try {
			const [attempt] = await db
				.select()
				.from(billingOperationAttempts)
				.where(
					and(
						eq(billingOperationAttempts.billingOperationId, claimed.id),
						eq(billingOperationAttempts.organizationId, claimed.organizationId),
						eq(billingOperationAttempts.revision, claimed.attemptRevision),
					),
				)
				.limit(1);
			if (!attempt) {
				throw new MissingBillingAttemptError(
					`Billing operation ${claimed.id} has no immutable revision ${claimed.attemptRevision}`,
				);
			}
			durableAttempt = attempt;
			requestStaged = attempt.status === "requesting";
			if (
				attempt.stripeCustomerId !== claimed.stripeCustomerId ||
				attempt.stripeSubscriptionId !== claimed.stripeSubscriptionId ||
				attempt.stripeInvoiceId !== claimed.stripeInvoiceId ||
				attempt.amountCents !== claimed.amountCents ||
				attempt.currency !== claimed.currency ||
				attempt.description !== claimed.description ||
				attempt.idempotencyKey !== claimed.idempotencyKey
			) {
				throw new MissingBillingAttemptError(
					`Billing operation ${claimed.id} disagrees with immutable attempt ${attempt.id}`,
				);
			}
			if (attempt.status === "rejected" || attempt.status === "written_off") {
				throw new MissingBillingAttemptError(
					`Billing operation ${claimed.id} references resolved attempt ${attempt.status}`,
				);
			}

			// Reconcile on every claim, including the first. This covers a worker that
			// lost its database response after Stripe accepted the exact item.
			await heartbeatExactOperationScope(db, exactScope, claimed);
			const existing = await findStripeInvoiceItem(client, claimed, attempt);
			if (existing) {
				providerEffectExists = true;
				const requestAttempt =
					attempt.status === "prepared"
						? await markAttemptRequesting(db, claimed, attempt)
						: attempt;
				if (!requestAttempt) {
					throw new MissingBillingAttemptError(
						`Billing attempt ${attempt.id} could not be staged for reconciliation`,
					);
				}
				durableAttempt = requestAttempt;
				await heartbeatExactOperationScope(db, exactScope, claimed);
				await ensureCatchupInvoiceFinalized(client, claimed, requestAttempt);
				if (
					await markSucceeded(
						db,
						claimed,
						requestAttempt,
						existing,
						true,
						exactScope,
					)
				) {
					succeeded++;
				}
				continue;
			}
			await heartbeatExactOperationScope(db, exactScope, claimed);
			await assertDraftInvoiceTarget(client, attempt);

			const [period] = await db
				.select()
				.from(billingPeriods)
				.where(
					and(
						eq(billingPeriods.id, claimed.billingPeriodId),
						eq(billingPeriods.organizationId, claimed.organizationId),
					),
				)
				.limit(1);
			if (!period) {
				throw new ExactInvoiceTargetError(
					`Billing period ${claimed.billingPeriodId} is missing`,
				);
			}
			if (!period.taxBehavior || period.discountable === null) {
				throw new ExactInvoiceTargetError(
					`Billing period ${period.id} is missing immutable tax terms`,
				);
			}
			if (
				period.stripeCustomerId !== attempt.stripeCustomerId ||
				period.stripeSubscriptionId !== attempt.stripeSubscriptionId
			) {
				throw new ExactInvoiceTargetError(
					`Billing operation ${claimed.id} disagrees with its immutable agreement snapshot`,
				);
			}

			const periodStart = Math.floor(period.periodStart.getTime() / 1000);
			// billing_periods uses an exclusive end. Stripe invoice-item service
			// periods are inclusive, so do not overlap the successor by one second.
			const periodEnd = Math.max(
				periodStart,
				Math.floor(period.periodEnd.getTime() / 1000) - 1,
			);

			const requesting = await markAttemptRequesting(db, claimed, attempt);
			if (!requesting) {
				throw new MissingBillingAttemptError(
					`Billing attempt ${attempt.id} could not acquire its request fence`,
				);
			}
			durableAttempt = requesting;
			requestStaged = true;
			createAttempted = true;
			await heartbeatExactOperationScope(db, exactScope, claimed);
			const invoiceItem = await client.invoiceItems.create(
				{
					customer: requesting.stripeCustomerId,
					invoice: requesting.stripeInvoiceId,
					subscription: requesting.stripeSubscriptionId,
					amount: requesting.amountCents,
					currency: requesting.currency,
					description: requesting.description,
					discountable: period.discountable,
					tax_behavior: period.taxBehavior,
					...(period.taxCode ? { tax_code: period.taxCode } : {}),
					period: { start: periodStart, end: periodEnd },
					metadata: {
						relayapi_operation_id: claimed.id,
						relayapi_operation_kind: claimed.kind,
						relayapi_operation_revision: String(requesting.revision),
						billing_period_id: claimed.billingPeriodId,
						organization_id: claimed.organizationId,
						stripe_subscription_id: requesting.stripeSubscriptionId,
					},
				},
				{ idempotencyKey: requesting.idempotencyKey },
			);
			providerEffectExists = true;
			assertInvoiceItemTarget(invoiceItem, requesting);
			await heartbeatExactOperationScope(db, exactScope, claimed);
			await ensureCatchupInvoiceFinalized(client, claimed, requesting);
			if (
				await markSucceeded(
					db,
					claimed,
					requesting,
					invoiceItem,
					false,
					exactScope,
				)
			) {
				succeeded++;
			}
		} catch (error) {
			if (error instanceof StaleBillingOperationLeaseError) continue;
			if (error instanceof ClosedTargetInvoiceError && durableAttempt) {
				// The exhaustive exact-item reconciliation immediately before the
				// canonical invoice read proves this revision has no provider effect.
				// Once the invoice is closed, neither a prepared nor a previously staged
				// requesting attempt can acquire an item, so both are safe to rotate.
				await reviseClosedInvoiceAsCatchup(
					db,
					claimed,
					durableAttempt,
					error,
					exactScope,
				);
				continue;
			}
			let failure: unknown = error;
			const statusCode =
				error && typeof error === "object" && "statusCode" in error
					? (error as { statusCode?: number }).statusCode
					: undefined;
			// Validation/auth failures are known terminal failures. Network, timeout,
			// 409, 429 and 5xx outcomes can be ambiguous and must reconcile first.
			const permanentProviderError = Boolean(
				statusCode &&
					statusCode >= 400 &&
					statusCode < 500 &&
					statusCode !== 409 &&
					statusCode !== 429,
			);
			if (
				createAttempted &&
				!providerEffectExists &&
				permanentProviderError &&
				durableAttempt?.status === "requesting"
			) {
				// Stripe can finalize a draft invoice between the preflight read and
				// invoice-item creation. A rejected create is safe to rotate only after
				// exact reconciliation proves that this revision produced no item and a
				// canonical invoice read proves that the immutable target is now closed.
				await heartbeatExactOperationScope(db, exactScope, claimed);
				const reconciledItem = await findStripeInvoiceItem(
					client,
					claimed,
					durableAttempt,
				);
				if (reconciledItem) {
					providerEffectExists = true;
					await ensureCatchupInvoiceFinalized(client, claimed, durableAttempt);
					if (
						await markSucceeded(
							db,
							claimed,
							durableAttempt,
							reconciledItem,
							true,
							exactScope,
						)
					) {
						succeeded++;
					}
					continue;
				}
				try {
					await assertDraftInvoiceTarget(client, durableAttempt);
				} catch (targetError) {
					if (targetError instanceof ClosedTargetInvoiceError) {
						await reviseClosedInvoiceAsCatchup(
							db,
							claimed,
							durableAttempt,
							targetError,
							exactScope,
						);
						continue;
					}
					failure = targetError;
				}
			}
			const message =
				failure instanceof Error ? failure.message : String(failure);
			// A permanent error from the reconciliation read does not prove the
			// earlier create was rejected. Preserve that ambiguity for an operator;
			// only a permanent response to this worker's create is terminal.
			const invalidTarget =
				failure instanceof ExactInvoiceTargetError ||
				failure instanceof MissingBillingAttemptError;
			const terminal =
				createAttempted &&
				!providerEffectExists &&
				permanentProviderError &&
				!invalidTarget;
			const reconciliationBlocked = !createAttempted && permanentProviderError;
			const finalizationBlocked =
				providerEffectExists && permanentProviderError;
			const completedAt = new Date();
			const manualReviewClass = billingOperationNeedsManualReview(
				{
					attempts: claimed.attempts,
					createdAt: claimed.createdAt,
				},
				completedAt,
			);
			const manualReview =
				invalidTarget ||
				reconciliationBlocked ||
				finalizationBlocked ||
				manualReviewClass === "retry_exhausted";
			const ambiguous =
				requestStaged || createAttempted || providerEffectExists;
			await markFailed(
				db,
				claimed,
				durableAttempt,
				{
					message,
					statusCode,
					terminal,
					manualReview,
					errorClass:
						terminal ||
						invalidTarget ||
						reconciliationBlocked ||
						finalizationBlocked
							? "permanent"
							: (manualReviewClass ?? (ambiguous ? "unknown" : "transient")),
					requestStaged,
					ambiguous,
				},
				exactScope,
			);
		}
	}

	return succeeded;
}

/**
 * Global cron/recovery sweep. This deliberately retains the existing
 * account-wide ordering and batch limit.
 */
export async function processOverageBillingOperations(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	stripe?: Stripe,
	limit = 50,
): Promise<number> {
	return processOverageBillingOperationsInternal(env, db, stripe, limit, null);
}

/**
 * Process only the operation created for one fenced invoice.created period.
 * Unlike the cron sweep, this path performs no account-wide recovery updates.
 */
export async function processExactOverageBillingOperation(
	env: Env,
	scope: ExactOverageBillingOperationScope,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	stripe?: Stripe,
): Promise<number> {
	assertExactOperationScope(scope);
	return processOverageBillingOperationsInternal(env, db, stripe, 1, scope);
}

/**
 * Hosted cron owner for both phases of overage recovery. Sharing one database
 * handle and one Stripe client keeps the every-minute idle path bounded while
 * catch-up invoices are always made authoritative before their item attempt.
 */
export async function recoverBillingOperations(env: Env): Promise<{
	activatedCatchupInvoices: number;
	succeededOperations: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
	const activatedCatchupInvoices = await processCatchupInvoiceOperations(
		env,
		db,
		stripe,
	);
	const succeededOperations = await processOverageBillingOperations(
		env,
		db,
		stripe,
	);
	return { activatedCatchupInvoices, succeededOperations };
}
