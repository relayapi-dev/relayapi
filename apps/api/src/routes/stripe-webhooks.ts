import { getBillingPolicy, PRICING } from "@relayapi/config";
import {
	billingOperationAttempts,
	billingOperations,
	billingOutbox,
	billingPeriods,
	createDb,
	type Database,
	dunningEvents,
	financialRetentionReceipts,
	invoices,
	organizationSubscriptions,
	stripeEvents,
	subscriptionCheckoutOperations,
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
import { Hono } from "hono";
import type Stripe from "stripe";
import {
	BASE_PRICE_TAX_BEHAVIOR,
	BASE_PRICE_TAX_CODE,
	BILLING_RATE_CARD_VERSION,
	LATE_BILLING_EFFECT_ALERT_PREFIX,
	LATE_BILLING_EFFECT_COMPENSATED_PREFIX,
	LATE_BILLING_EFFECT_WAIVED_PREFIX,
	OVERAGE_DISCOUNTABLE,
	STRIPE_FINANCIAL_EVENT_MANIFEST,
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import {
	ResponseTooLargeError,
	readRequestText,
} from "../lib/fetch-public-url";
import { processExactOverageBillingOperation } from "../services/billing-operations";
import {
	ensureHostedFreeUsageAuthority,
	resumeStripeBillingPeriod,
	shortenOpenBillingPeriod,
	splitBillingPeriod,
} from "../services/billing-periods";
import {
	digestFinancialExternalSourceId,
	financialStripeEventAdvisoryLockKey,
} from "../services/financial-retention";
import {
	claimBillingPeriod,
	invoiceLineMatchesBillingPeriod,
} from "../services/invoice-generator";
import { wakePhoneAddonBillingReconciliation } from "../services/phone-number-operations";
import { createStripeClient } from "../services/stripe";
import {
	assertStripeOrganizationFence,
	claimStripeOrganizationFence,
	releaseStripeOrganizationFence,
	type StripeOrganizationFence,
} from "../services/stripe-organization-lease";
import {
	isRelayApiBaseSubscription,
	mapStripeSubscriptionStatus,
	relayApiSubscriptionRole,
} from "../services/stripe-subscriptions";
import type { Env } from "../types";

export { mapStripeSubscriptionStatus } from "../services/stripe-subscriptions";

const app = new Hono<{ Bindings: Env }>();
const EVENT_LEASE_MS = 5 * 60 * 1000;
export const STRIPE_RECOVERY_MAX_ATTEMPTS = 160;
export const STRIPE_RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;
const STRIPE_AUTOMATIC_RECOVERY_ERROR_CLASSES = [
	"transient",
	"unresolved",
	"retry_exhausted",
	"age_exhausted",
] as const;

type StripeRecoveryErrorClass = "transient" | "permanent";

export function classifyStripeRecoveryError(
	error: unknown,
): StripeRecoveryErrorClass {
	const statusCode =
		error && typeof error === "object" && "statusCode" in error
			? (error as { statusCode?: unknown }).statusCode
			: undefined;
	if (
		typeof statusCode === "number" &&
		statusCode >= 400 &&
		statusCode < 500 &&
		statusCode !== 409 &&
		statusCode !== 429
	) {
		return "permanent";
	}
	return "transient";
}

function stripeEventRetryAt(attempts: number, now: Date): Date {
	const delaySeconds = Math.min(6 * 60 * 60, 2 ** Math.min(attempts, 15));
	return new Date(now.getTime() + delaySeconds * 1000);
}

function stripeEventAutomaticRecoveryStatus() {
	return or(
		eq(stripeEvents.status, "pending"),
		and(
			eq(stripeEvents.status, "failed"),
			or(
				isNull(stripeEvents.lastErrorClass),
				inArray(
					stripeEvents.lastErrorClass,
					STRIPE_AUTOMATIC_RECOVERY_ERROR_CLASSES,
				),
			),
		),
	);
}

class UnresolvedStripeEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnresolvedStripeEventError";
	}
}

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const STRIPE_FINANCIAL_EVENTS = new Set<string>(
	STRIPE_FINANCIAL_EVENT_MANIFEST,
);

async function resolveStripeEventOrganizationId(
	db: Database,
	event: Stripe.Event,
): Promise<string | null> {
	const [durableAttribution] = await db
		.select({ organizationId: stripeEvents.organizationId })
		.from(stripeEvents)
		.where(eq(stripeEvents.id, event.id))
		.limit(1);
	if (durableAttribution?.organizationId) {
		return durableAttribution.organizationId;
	}

	const object = event.data.object as {
		metadata?: Record<string, string> | null;
		customer?: string | { id: string } | null;
	};
	const metadataOrganizationId =
		object.metadata?.organizationId ??
		object.metadata?.relayapi_organization_id ??
		null;
	const customerId = eventCustomerId(event);
	const subscriptionId = eventSubscriptionId(event);
	const conditions = [];
	if (metadataOrganizationId) {
		conditions.push(
			eq(organizationSubscriptions.organizationId, metadataOrganizationId),
		);
	}
	if (customerId) {
		conditions.push(eq(organizationSubscriptions.stripeCustomerId, customerId));
	}
	if (subscriptionId) {
		conditions.push(
			eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
		);
	}
	if (conditions.length === 0) return null;
	const rows = await db
		.select({ organizationId: organizationSubscriptions.organizationId })
		.from(organizationSubscriptions)
		.where(or(...conditions))
		.limit(3);
	const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
	if (organizationIds.length > 1) {
		throw new UnresolvedStripeEventError(
			`Stripe event ${event.id} maps to multiple organizations`,
		);
	}
	return organizationIds[0] ?? null;
}

async function wakePhoneAddonFromSubscription(
	db: Database,
	event: Stripe.Event,
	subscription: Pick<Stripe.Subscription, "metadata">,
	fence: StripeOrganizationFence | null,
): Promise<boolean> {
	if (
		relayApiSubscriptionRole(subscription) !==
		STRIPE_SUBSCRIPTION_ROLES.phoneAddon
	) {
		return false;
	}
	const organizationId = subscription.metadata.organizationId;
	if (!organizationId) {
		throw new UnresolvedStripeEventError(
			`Phone add-on event ${event.id} has no organization metadata`,
		);
	}
	if (fence && fence.organizationId !== organizationId) {
		throw new UnresolvedStripeEventError(
			`Phone add-on event ${event.id} disagrees with its organization fence`,
		);
	}
	await assertStripeOrganizationFence(db, fence);
	await wakePhoneAddonBillingReconciliation(
		db,
		organizationId,
		`${event.type}:${event.id}`,
		fence,
	);
	return true;
}

/**
 * Bind a claimed provider receipt to one tenant. The database trigger permits
 * NULL -> organization exactly once and rejects clearing/reassignment; these
 * predicates additionally fail closed before attempting a conflicting write.
 */
export async function persistStripeEventOrganizationAttribution(
	db: Database,
	input: { eventId: string; organizationId: string; leaseToken: number },
): Promise<void> {
	const [attributed] = await db
		.update(stripeEvents)
		.set({
			organizationId: input.organizationId,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(stripeEvents.id, input.eventId),
				eq(stripeEvents.status, "processing"),
				eq(stripeEvents.leaseToken, input.leaseToken),
				or(
					isNull(stripeEvents.organizationId),
					eq(stripeEvents.organizationId, input.organizationId),
				),
			),
		)
		.returning({ organizationId: stripeEvents.organizationId });
	if (attributed?.organizationId !== input.organizationId) {
		throw new UnresolvedStripeEventError(
			`Stripe event ${input.eventId} organization attribution conflicted with its durable receipt`,
		);
	}
}

function stripeId(
	value: string | { id: string } | null | undefined,
): string | null {
	if (!value) return null;
	return typeof value === "string" ? value : value.id;
}

/** Extract subscription ID from an invoice's current parent shape. */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	const details = invoice.parent?.subscription_details;
	return stripeId(details?.subscription);
}

function getSubscriptionPeriod(subscription: Stripe.Subscription): {
	start: Date | null;
	end: Date | null;
} {
	const firstItem = subscription.items?.data?.[0];
	return {
		start: firstItem ? new Date(firstItem.current_period_start * 1000) : null,
		end: firstItem ? new Date(firstItem.current_period_end * 1000) : null,
	};
}

function subscriptionValues(subscription: Stripe.Subscription) {
	const period = getSubscriptionPeriod(subscription);
	const status = mapStripeSubscriptionStatus(subscription.status);
	return {
		status,
		source: "stripe" as const,
		delinquentAt:
			status === "past_due"
				? sql`COALESCE(${organizationSubscriptions.delinquentAt}, statement_timestamp())`
				: null,
		graceEndsAt:
			status === "past_due"
				? sql`COALESCE(
					${organizationSubscriptions.graceEndsAt},
					${organizationSubscriptions.delinquentAt} + INTERVAL '14 days',
					statement_timestamp() + INTERVAL '14 days'
				)`
				: null,
		stripeCustomerId: stripeId(subscription.customer),
		stripeSubscriptionId: subscription.id,
		trialEndsAt: subscription.trial_end
			? new Date(subscription.trial_end * 1000)
			: null,
		cancelAtPeriodEnd:
			subscription.cancel_at_period_end || Boolean(subscription.cancel_at),
		...(period.start ? { currentPeriodStart: period.start } : {}),
		...(period.end ? { currentPeriodEnd: period.end } : {}),
		updatedAt: new Date(),
	};
}

function stripeBillingTerms(
	subscription: Stripe.Subscription,
	status: ReturnType<typeof mapStripeSubscriptionStatus>,
) {
	if (!isRelayApiBaseSubscription(subscription)) {
		throw new UnresolvedStripeEventError(
			`Subscription ${subscription.id} is not a RelayAPI base subscription`,
		);
	}
	const price = subscription.items.data[0]?.price;
	const customerId = stripeId(subscription.customer);
	const productId = price ? stripeId(price.product) : null;
	if (!price || !customerId || !productId) {
		throw new UnresolvedStripeEventError(
			"Base subscription has no immutable customer, product, or price identity",
		);
	}
	if (price?.currency && price.currency !== "usd") {
		throw new UnresolvedStripeEventError(
			`RelayAPI supports USD subscriptions only; received ${price.currency}`,
		);
	}
	const billable = status === "active";
	return {
		source: "stripe" as const,
		stripeCustomerId: customerId,
		stripeSubscriptionId: subscription.id,
		stripeProductId: productId,
		stripePriceId: price.id,
		stripePriceRole: STRIPE_SUBSCRIPTION_ROLES.base,
		rateCardVersion: BILLING_RATE_CARD_VERSION,
		taxBehavior: price.tax_behavior ?? BASE_PRICE_TAX_BEHAVIOR,
		taxCode: BASE_PRICE_TAX_CODE,
		discountable: OVERAGE_DISCOUNTABLE,
		billable,
		quotaMode: billable ? ("metered" as const) : ("hard" as const),
		cycleAllowance: PRICING.proCallsIncluded,
		pricePerThousandUnitsCents: billable
			? PRICING.pricePerThousandCallsCents
			: null,
		basePriceCents: price?.unit_amount ?? 0,
		currency: "usd" as const,
	};
}

async function synchronizeStripeBillingPeriod(
	db: Database,
	input: {
		organizationId: string;
		subscription: Stripe.Subscription;
		status: ReturnType<typeof mapStripeSubscriptionStatus>;
		effectiveAt: Date;
		fence?: StripeOrganizationFence | null;
	},
): Promise<void> {
	const providerPeriod = getSubscriptionPeriod(input.subscription);
	if (!providerPeriod.start || !providerPeriod.end) {
		throw new UnresolvedStripeEventError(
			"Stripe subscription has no authoritative billing window",
		);
	}
	const providerStart = providerPeriod.start;
	const providerEnd = providerPeriod.end;
	const entitlementAt = new Date();
	const [localSubscription] = await db
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, input.organizationId))
		.limit(1);
	if (!localSubscription) {
		throw new UnresolvedStripeEventError(
			`Organization ${input.organizationId} has no subscription projection`,
		);
	}
	if (
		getBillingPolicy(localSubscription, entitlementAt).entitlement !== "pro"
	) {
		await ensureHostedFreeUsageAuthority(db, {
			organizationId: input.organizationId,
			now: entitlementAt,
			fence: input.fence,
		});
		return;
	}
	const terms = stripeBillingTerms(input.subscription, input.status);
	const effectiveAt =
		input.effectiveAt < providerStart ? providerStart : input.effectiveAt;
	const split = await splitBillingPeriod(db, {
		organizationId: input.organizationId,
		providerCycleAnchor: providerStart,
		effectiveAt,
		terms,
		fence: input.fence,
	});
	if (split) return;
	const resumed = await resumeStripeBillingPeriod(db, {
		organizationId: input.organizationId,
		expectedStripeSubscriptionId: input.subscription.id,
		providerCycleAnchor: providerStart,
		providerPeriodEnd: providerEnd,
		effectiveAt,
		entitlementAt,
		terms,
		fence: input.fence,
	});
	if (resumed) return;

	// A delayed past_due event must not open a fresh hard/Pro cycle after the
	// original 14-day grace has expired. Normalize any stale current authority
	// to Free; a genuinely entitled subscription that still has no authority is
	// left retryable in the durable Stripe receipt.
	const transitioned = await ensureHostedFreeUsageAuthority(db, {
		organizationId: input.organizationId,
		now: entitlementAt,
		fence: input.fence,
	});
	if (transitioned) return;
	throw new Error(
		`Stripe subscription ${input.subscription.id} has no current usage authority`,
	);
}

function eventSubscriptionId(event: Stripe.Event): string | null {
	const object = event.data.object;
	if (event.type.startsWith("customer.subscription.")) {
		return (object as Stripe.Subscription).id;
	}
	if (event.type.startsWith("invoice.")) {
		return getInvoiceSubscriptionId(object as Stripe.Invoice);
	}
	if (
		event.type === "checkout.session.completed" ||
		event.type === "checkout.session.async_payment_succeeded" ||
		event.type === "checkout.session.async_payment_failed"
	) {
		return stripeId((object as Stripe.Checkout.Session).subscription);
	}
	return null;
}

function eventCustomerId(event: Stripe.Event): string | null {
	const object = event.data.object as {
		customer?: string | { id: string } | null;
	};
	return stripeId(object.customer);
}

async function enqueueBillingEffects(
	tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
	eventId: string,
	organizationId: string,
	opts?: { paymentFailedInvoiceId?: string },
): Promise<void> {
	const rows: Array<typeof billingOutbox.$inferInsert> = [
		{
			id: `stripe:${eventId}:auth:${organizationId}`,
			organizationId,
			kind: "auth_cache.refresh",
			payload: { eventId },
		},
	];
	if (opts?.paymentFailedInvoiceId) {
		rows.push({
			id: `stripe:${eventId}:payment-failed:${organizationId}`,
			organizationId,
			kind: "payment_failed.notify",
			payload: { invoiceId: opts.paymentFailedInvoiceId },
		});
	}
	await tx.insert(billingOutbox).values(rows).onConflictDoNothing();
}

function canonicalInvoiceStatus(invoice: Stripe.Invoice): {
	status: "draft" | "finalized" | "paid" | "void";
	paidAt: Date | null;
} {
	if (invoice.status === "paid") {
		return {
			status: "paid",
			paidAt: new Date(
				(invoice.status_transitions?.paid_at ?? invoice.created) * 1000,
			),
		};
	}
	if (invoice.status === "void" || invoice.status === "uncollectible") {
		return { status: "void", paidAt: null };
	}
	if (invoice.status === "draft") return { status: "draft", paidAt: null };
	return { status: "finalized", paidAt: null };
}

type InvoiceBillingEvidence = {
	operationId: string | null;
	operationRevision: number | null;
	invoiceItemId: string | null;
	amountCents: number;
	currency: string;
};

async function listAllInvoiceLines(
	stripe: Stripe,
	invoice: Stripe.Invoice,
): Promise<Stripe.InvoiceLineItem[]> {
	if (!invoice.lines?.has_more) return invoice.lines?.data ?? [];
	const lines: Stripe.InvoiceLineItem[] = [];
	for await (const line of stripe.invoices.listLineItems(invoice.id, {
		limit: 100,
	})) {
		lines.push(line);
	}
	return lines;
}

async function collectInvoiceBillingEvidence(
	stripe: Stripe,
	invoice: Stripe.Invoice,
): Promise<{
	evidence: InvoiceBillingEvidence[];
	basePriceCents: number;
}> {
	const lines = await listAllInvoiceLines(stripe, invoice);
	if (
		invoice.currency !== "usd" ||
		lines.some((line) => line.currency !== "usd")
	) {
		throw new UnresolvedStripeEventError(
			`RelayAPI supports USD invoices only; received ${invoice.currency}`,
		);
	}
	const evidence = lines.flatMap((line) => {
		const operationId = line.metadata?.relayapi_operation_id ?? null;
		const revisionValue = line.metadata?.relayapi_operation_revision;
		const operationRevision = revisionValue ? Number(revisionValue) : null;
		if (
			revisionValue &&
			(!Number.isSafeInteger(operationRevision) ||
				(operationRevision ?? 0) <= 0)
		) {
			throw new UnresolvedStripeEventError(
				`Invoice line ${line.id} has an invalid billing operation revision`,
			);
		}
		const invoiceItemId =
			line.parent?.invoice_item_details?.invoice_item ?? null;
		return operationId || invoiceItemId
			? [
					{
						operationId,
						operationRevision,
						invoiceItemId,
						amountCents: line.amount,
						currency: line.currency,
					},
				]
			: [];
	});
	const nonOverageLineAmount = lines
		.filter((line) => !line.metadata?.relayapi_operation_id)
		.reduce((sum, line) => sum + Math.max(0, line.amount), 0);
	return {
		evidence,
		basePriceCents:
			lines.length === 0
				? Math.max(
						0,
						invoice.amount_due -
							evidence.reduce(
								(sum, item) => sum + Math.max(0, item.amountCents),
								0,
							),
					)
				: nonOverageLineAmount,
	};
}

async function reconcileInvoiceBillingPeriods(
	tx: BillingTransaction,
	input: {
		invoiceId: string;
		stripeInvoiceId: string;
		organizationId: string;
		evidence: InvoiceBillingEvidence[];
		occurredAt: Date;
	},
): Promise<void> {
	const operationIds = [
		...new Set(
			input.evidence.flatMap((item) =>
				item.operationId ? [item.operationId] : [],
			),
		),
	];
	const invoiceItemIds = [
		...new Set(
			input.evidence.flatMap((item) =>
				item.invoiceItemId ? [item.invoiceItemId] : [],
			),
		),
	];
	const matched = new Map<string, typeof billingOperations.$inferSelect>();
	if (operationIds.length > 0) {
		const rows = await tx
			.select()
			.from(billingOperations)
			.where(
				and(
					eq(billingOperations.organizationId, input.organizationId),
					inArray(billingOperations.id, operationIds),
				),
			)
			.for("update")
			.limit(250);
		for (const row of rows) matched.set(row.id, row);
	}
	if (invoiceItemIds.length > 0) {
		const rows = await tx
			.select()
			.from(billingOperations)
			.where(
				and(
					eq(billingOperations.organizationId, input.organizationId),
					inArray(billingOperations.stripeInvoiceItemId, invoiceItemIds),
				),
			)
			.for("update")
			.limit(250);
		for (const row of rows) matched.set(row.id, row);
	}

	for (const operation of matched.values()) {
		const operationEvidence = input.evidence.filter(
			(item) =>
				item.operationId === operation.id ||
				item.invoiceItemId === operation.stripeInvoiceItemId,
		);
		const anyInvoiceItemEvidence = operationEvidence.find(
			(item) => item.invoiceItemId,
		);
		const exactProviderEvidence = operationEvidence.find(
			(item) =>
				Boolean(item.invoiceItemId) &&
				item.operationId === operation.id &&
				item.operationRevision === operation.attemptRevision &&
				item.amountCents === operation.amountCents &&
				item.currency === operation.currency,
		);
		if (
			["terminal_failed", "released", "written_off"].includes(operation.status)
		) {
			if (
				operation.stripeInvoiceId !== input.stripeInvoiceId ||
				!exactProviderEvidence?.invoiceItemId
			) {
				if (anyInvoiceItemEvidence?.invoiceItemId) {
					console.error("[billing] terminal invoice evidence mismatch", {
						event: "billing_terminal_operation_invoice_evidence_mismatch",
						organizationId: input.organizationId,
						billingOperationId: operation.id,
						operationStatus: operation.status,
						stripeInvoiceId: input.stripeInvoiceId,
						stripeInvoiceItemId: anyInvoiceItemEvidence.invoiceItemId,
					});
				}
				continue;
			}
			if (
				operation.stripeInvoiceItemId === exactProviderEvidence.invoiceItemId &&
				(operation.lastError?.startsWith(
					LATE_BILLING_EFFECT_COMPENSATED_PREFIX,
				) ||
					operation.lastError?.startsWith(LATE_BILLING_EFFECT_WAIVED_PREFIX))
			) {
				console.error("[billing] late invoice evidence already resolved", {
					event: "billing_terminal_operation_late_evidence_already_resolved",
					organizationId: input.organizationId,
					billingOperationId: operation.id,
					operationStatus: operation.status,
					stripeInvoiceId: input.stripeInvoiceId,
					stripeInvoiceItemId: exactProviderEvidence.invoiceItemId,
				});
				continue;
			}
			const [attempt] = await tx
				.select()
				.from(billingOperationAttempts)
				.where(
					and(
						eq(billingOperationAttempts.billingOperationId, operation.id),
						eq(billingOperationAttempts.organizationId, input.organizationId),
						eq(billingOperationAttempts.revision, operation.attemptRevision),
					),
				)
				.for("update")
				.limit(1);
			const lateEvidence = {
				schema_version: 1,
				policy: "late_terminal_stripe_invoice_line_v1",
				decision: "retain_terminal_state_and_require_compensation",
				stripe_invoice_id: input.stripeInvoiceId,
				stripe_invoice_item_id: exactProviderEvidence.invoiceItemId,
				operation_revision: operation.attemptRevision,
				amount_cents: exactProviderEvidence.amountCents,
				currency: exactProviderEvidence.currency,
				required_operator_decision:
					"issue_compensating_invoice_or_credit_or_accept_writeoff",
				observed_at: input.occurredAt.toISOString(),
			};
			if (
				attempt &&
				["unknown", "succeeded", "rejected", "written_off"].includes(
					attempt.status,
				)
			) {
				const priorEvidence =
					attempt.providerEvidence &&
					typeof attempt.providerEvidence === "object" &&
					!Array.isArray(attempt.providerEvidence)
						? attempt.providerEvidence
						: attempt.providerEvidence == null
							? {}
							: { prior_provider_evidence: attempt.providerEvidence };
				await tx
					.update(billingOperationAttempts)
					.set({
						providerEvidence: {
							...priorEvidence,
							late_invoice_evidence: lateEvidence,
						},
						...(["succeeded", "rejected", "written_off"].includes(
							attempt.status,
						)
							? {
									stripeInvoiceItemId:
										attempt.stripeInvoiceItemId ??
										exactProviderEvidence.invoiceItemId,
								}
							: {}),
					})
					.where(
						and(
							eq(billingOperationAttempts.id, attempt.id),
							eq(billingOperationAttempts.status, attempt.status),
						),
					);
			}
			const alertMarker = `${LATE_BILLING_EFFECT_ALERT_PREFIX}invoice=${input.stripeInvoiceId};item=${exactProviderEvidence.invoiceItemId};revision=${operation.attemptRevision};amount_cents=${exactProviderEvidence.amountCents};currency=${exactProviderEvidence.currency};decision=manual_compensating_invoice_or_credit`;
			const [alertedOperation] = await tx
				.update(billingOperations)
				.set({
					stripeInvoiceItemId:
						operation.stripeInvoiceItemId ??
						exactProviderEvidence.invoiceItemId,
					lastError: alertMarker,
					lastErrorClass: "permanent",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(billingOperations.id, operation.id),
						eq(billingOperations.organizationId, input.organizationId),
						eq(billingOperations.status, operation.status),
						eq(billingOperations.attemptRevision, operation.attemptRevision),
					),
				)
				.returning({ id: billingOperations.id });
			if (!alertedOperation) {
				throw new UnresolvedStripeEventError(
					`Terminal billing operation ${operation.id} changed while retaining late invoice evidence`,
				);
			}
			console.error("[billing] late invoice evidence for terminal operation", {
				event: "billing_terminal_operation_late_invoice_evidence",
				organizationId: input.organizationId,
				billingOperationId: operation.id,
				billingPeriodId: operation.billingPeriodId,
				operationStatus: operation.status,
				stripeInvoiceId: input.stripeInvoiceId,
				stripeInvoiceItemId: exactProviderEvidence.invoiceItemId,
			});
			continue;
		}
		if (
			![
				"pending",
				"processing",
				"failed",
				"unknown",
				"manual_review",
				"succeeded",
			].includes(operation.status)
		) {
			continue;
		}
		const providerEvidence = exactProviderEvidence;
		if (
			operation.stripeInvoiceId !== input.stripeInvoiceId ||
			!providerEvidence?.invoiceItemId
		) {
			console.error("[billing] mismatched invoice operation evidence", {
				event: "billing_invoice_operation_evidence_mismatch",
				organizationId: input.organizationId,
				billingOperationId: operation.id,
				stripeInvoiceId: input.stripeInvoiceId,
				stripeInvoiceItemId: anyInvoiceItemEvidence?.invoiceItemId ?? null,
			});
			continue;
		}
		const [period] = await tx
			.select({ state: billingPeriods.state })
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, operation.billingPeriodId),
					eq(billingPeriods.organizationId, input.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (period?.state !== "claimed") {
			console.error("[billing] late invoice cannot settle terminal period", {
				event: "billing_terminal_period_late_invoice_evidence",
				organizationId: input.organizationId,
				billingOperationId: operation.id,
				billingPeriodId: operation.billingPeriodId,
				billingPeriodState: period?.state ?? "missing",
				stripeInvoiceId: input.stripeInvoiceId,
				stripeInvoiceItemId: providerEvidence.invoiceItemId,
			});
			continue;
		}
		const [attempt] = await tx
			.select()
			.from(billingOperationAttempts)
			.where(
				and(
					eq(billingOperationAttempts.billingOperationId, operation.id),
					eq(billingOperationAttempts.organizationId, input.organizationId),
					eq(billingOperationAttempts.revision, operation.attemptRevision),
				),
			)
			.for("update")
			.limit(1);
		if (
			!attempt ||
			attempt.stripeInvoiceId !== input.stripeInvoiceId ||
			attempt.amountCents !== providerEvidence.amountCents ||
			attempt.currency !== providerEvidence.currency ||
			!["requesting", "unknown", "succeeded"].includes(attempt.status)
		) {
			console.error("[billing] invoice evidence has no resolvable attempt", {
				event: "billing_invoice_attempt_evidence_mismatch",
				organizationId: input.organizationId,
				billingOperationId: operation.id,
				attemptRevision: operation.attemptRevision,
				stripeInvoiceId: input.stripeInvoiceId,
				stripeInvoiceItemId: providerEvidence.invoiceItemId,
			});
			continue;
		}
		if (attempt.status === "succeeded") {
			if (attempt.stripeInvoiceItemId !== providerEvidence.invoiceItemId) {
				console.error(
					"[billing] succeeded attempt has conflicting invoice item",
					{
						event: "billing_succeeded_attempt_invoice_item_conflict",
						organizationId: input.organizationId,
						billingOperationId: operation.id,
						attemptRevision: operation.attemptRevision,
					},
				);
				continue;
			}
		} else {
			const [resolvedAttempt] = await tx
				.update(billingOperationAttempts)
				.set({
					status: "succeeded",
					stripeInvoiceItemId: providerEvidence.invoiceItemId,
					providerEvidence: {
						schema_version: 1,
						policy: "canonical_stripe_invoice_line_v1",
						decision: "provider_effect_succeeded",
						stripe_invoice_id: input.stripeInvoiceId,
						stripe_invoice_item_id: providerEvidence.invoiceItemId,
						amount_cents: providerEvidence.amountCents,
						currency: providerEvidence.currency,
						observed_at: input.occurredAt.toISOString(),
					},
					resolvedAt: input.occurredAt,
				})
				.where(
					and(
						eq(billingOperationAttempts.id, attempt.id),
						inArray(billingOperationAttempts.status, ["requesting", "unknown"]),
					),
				)
				.returning({ id: billingOperationAttempts.id });
			if (!resolvedAttempt) {
				throw new UnresolvedStripeEventError(
					`Billing attempt ${attempt.id} changed while applying invoice evidence`,
				);
			}
		}
		const [resolvedOperation] = await tx
			.update(billingOperations)
			.set({
				status: "succeeded",
				stripeInvoiceItemId: providerEvidence.invoiceItemId,
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				leaseExpiresAt: null,
				lastError: null,
				lastErrorClass: null,
				operatorRetryRequestedAt: null,
				completedAt: sql`COALESCE(${billingOperations.completedAt}, ${input.occurredAt})`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, input.organizationId),
					eq(billingOperations.attemptRevision, attempt.revision),
					inArray(billingOperations.status, [
						"pending",
						"processing",
						"failed",
						"unknown",
						"manual_review",
						"succeeded",
					]),
				),
			)
			.returning({ id: billingOperations.id });
		if (!resolvedOperation) {
			throw new UnresolvedStripeEventError(
				`Billing operation ${operation.id} changed while applying invoice evidence`,
			);
		}
		const [settledPeriod] = await tx
			.update(billingPeriods)
			.set({
				state: "settled",
				invoiceId: input.invoiceId,
				stripeInvoiceId: input.stripeInvoiceId,
				settledAt: input.occurredAt,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(billingPeriods.id, operation.billingPeriodId),
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "claimed"),
				),
			)
			.returning({ id: billingPeriods.id });
		if (!settledPeriod) {
			throw new UnresolvedStripeEventError(
				`Billing period ${operation.billingPeriodId} changed while applying invoice evidence`,
			);
		}
	}

	const [usageSummary] = await tx
		.select({
			committedUnits: sql<number>`COALESCE(SUM(${billingPeriods.committedUnitsSnapshot}), 0)::bigint`,
			includedUnits: sql<number>`COALESCE(MAX(${billingPeriods.cycleAllowance}), 0)::bigint`,
			overageUnits: sql<number>`COALESCE(SUM(${billingPeriods.overageUnitsSnapshot}), 0)::bigint`,
			amountCents: sql<number>`COALESCE(SUM(${billingPeriods.amountCentsSnapshot}), 0)::integer`,
		})
		.from(billingPeriods)
		.where(
			and(
				eq(billingPeriods.invoiceId, input.invoiceId),
				eq(billingPeriods.organizationId, input.organizationId),
			),
		);
	if (!usageSummary) return;
	for (const [name, value] of Object.entries(usageSummary)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new UnresolvedStripeEventError(
				`Invoice usage summary ${name} is outside the JavaScript safe-integer range`,
			);
		}
	}
	await tx
		.update(invoices)
		.set({
			apiCallsCount: usageSummary.committedUnits,
			apiCallsIncluded: usageSummary.includedUnits,
			overageCalls: usageSummary.overageUnits,
			overageCostCents: usageSummary.amountCents,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(invoices.id, input.invoiceId),
				eq(invoices.organizationId, input.organizationId),
			),
		);
}

/**
 * Apply a verified Stripe event using canonical Stripe object state. External
 * reads happen before the short DB transaction, so delayed events cannot
 * regress newer subscription/invoice state and no transaction spans HTTP/KV.
 */
export async function handleEvent(
	event: Stripe.Event,
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	fence: StripeOrganizationFence | null = null,
): Promise<void> {
	const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);

	if (
		event.type === "checkout.session.completed" ||
		event.type === "checkout.session.async_payment_succeeded" ||
		event.type === "checkout.session.async_payment_failed"
	) {
		const session = event.data.object as Stripe.Checkout.Session;
		if (session.mode !== "subscription") return;
		const subscriptionId = stripeId(session.subscription);
		const subscription = subscriptionId
			? await stripe.subscriptions.retrieve(subscriptionId)
			: null;
		const sessionRole =
			session.metadata?.[STRIPE_MANAGED_BY_KEY] === STRIPE_MANAGED_BY_VALUE
				? session.metadata?.[STRIPE_SUBSCRIPTION_ROLE_KEY]
				: null;
		const role =
			sessionRole === STRIPE_SUBSCRIPTION_ROLES.base ||
			sessionRole === STRIPE_SUBSCRIPTION_ROLES.phoneAddon
				? sessionRole
				: subscription
					? relayApiSubscriptionRole(subscription)
					: null;

		let organizationId =
			session.metadata?.organizationId ||
			subscription?.metadata?.organizationId ||
			null;
		if (organizationId) {
			const [existing] = await db
				.select({ organizationId: organizationSubscriptions.organizationId })
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.organizationId, organizationId))
				.limit(1);
			organizationId = existing?.organizationId ?? null;
		}
		if (!organizationId) {
			const customerId = stripeId(session.customer);
			if (customerId) {
				const [existing] = await db
					.select({ organizationId: organizationSubscriptions.organizationId })
					.from(organizationSubscriptions)
					.where(eq(organizationSubscriptions.stripeCustomerId, customerId))
					.limit(1);
				organizationId = existing?.organizationId ?? null;
			}
		}
		if (!organizationId) {
			console.error("Stripe checkout: cannot resolve organization", {
				eventId: event.id,
				sessionId: session.id,
			});
			throw new UnresolvedStripeEventError(
				"checkout session could not be mapped to an organization",
			);
		}
		if (fence && fence.organizationId !== organizationId) {
			throw new UnresolvedStripeEventError(
				`Checkout ${session.id} disagrees with its organization fence`,
			);
		}
		if (role === STRIPE_SUBSCRIPTION_ROLES.phoneAddon) {
			await assertStripeOrganizationFence(db, fence);
			await wakePhoneAddonBillingReconciliation(
				db,
				organizationId,
				`${event.type}:${event.id}`,
				fence,
			);
			return;
		}
		if (role !== STRIPE_SUBSCRIPTION_ROLES.base) {
			throw new UnresolvedStripeEventError(
				`Checkout ${session.id} created an unrecognized subscription role`,
			);
		}
		if (event.type === "checkout.session.async_payment_failed") {
			await db.transaction(async (tx) => {
				await assertStripeOrganizationFence(tx, fence);
				await tx
					.update(subscriptionCheckoutOperations)
					.set({
						status: "failed",
						completedAt: new Date(),
						leaseExpiresAt: null,
						lastError: "Stripe Checkout asynchronous payment failed",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(subscriptionCheckoutOperations.organizationId, organizationId),
							eq(
								subscriptionCheckoutOperations.stripeCheckoutSessionId,
								session.id,
							),
						),
					);
			});
			return;
		}
		if (!subscription) {
			throw new UnresolvedStripeEventError(
				`Successful Checkout ${session.id} has no subscription`,
			);
		}

		await db.transaction(async (tx) => {
			await assertStripeOrganizationFence(tx, fence);
			await tx
				.update(organizationSubscriptions)
				.set({
					...subscriptionValues(subscription),
					stripeCustomerId:
						stripeId(session.customer) ?? stripeId(subscription.customer),
				})
				.where(eq(organizationSubscriptions.organizationId, organizationId));
			await tx
				.update(subscriptionCheckoutOperations)
				.set({
					status: "completed",
					completedAt: new Date(),
					leaseExpiresAt: null,
					lastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(subscriptionCheckoutOperations.organizationId, organizationId),
						eq(
							subscriptionCheckoutOperations.stripeCheckoutSessionId,
							session.id,
						),
					),
				);
			await enqueueBillingEffects(tx, event.id, organizationId);
		});
		await assertStripeOrganizationFence(db, fence);
		await synchronizeStripeBillingPeriod(db, {
			organizationId,
			subscription,
			status: mapStripeSubscriptionStatus(subscription.status),
			effectiveAt: new Date(event.created * 1000),
			fence,
		});
		return;
	}

	if (
		event.type === "customer.subscription.created" ||
		event.type === "customer.subscription.updated"
	) {
		const snapshot = event.data.object as Stripe.Subscription;
		const canonical = await stripe.subscriptions.retrieve(snapshot.id);
		if (await wakePhoneAddonFromSubscription(db, event, canonical, fence)) {
			return;
		}
		if (!isRelayApiBaseSubscription(canonical)) {
			// Add-ons have their own lifecycle and never confer base entitlement.
			return;
		}
		let organizationId: string | null = null;
		await db.transaction(async (tx) => {
			await assertStripeOrganizationFence(tx, fence);
			const [local] = await tx
				.select({
					id: organizationSubscriptions.id,
					organizationId: organizationSubscriptions.organizationId,
				})
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.stripeSubscriptionId, canonical.id))
				.limit(1);
			if (!local) return;
			if (fence && fence.organizationId !== local.organizationId) {
				throw new UnresolvedStripeEventError(
					`Subscription ${canonical.id} disagrees with its durable organization attribution`,
				);
			}
			organizationId = local.organizationId;
			await tx
				.update(organizationSubscriptions)
				.set(subscriptionValues(canonical))
				.where(eq(organizationSubscriptions.id, local.id));
			await enqueueBillingEffects(tx, event.id, local.organizationId);
		});
		if (organizationId) {
			await assertStripeOrganizationFence(db, fence);
			const effectiveAt = new Date(event.created * 1000);
			const status = mapStripeSubscriptionStatus(canonical.status);
			if (status === "cancelled") {
				await shortenOpenBillingPeriod(db, {
					organizationId,
					effectiveAt,
					fence,
				});
			} else {
				await synchronizeStripeBillingPeriod(db, {
					organizationId,
					subscription: canonical,
					status,
					effectiveAt,
					fence,
				});
			}
		}
		return;
	}

	if (event.type === "customer.subscription.deleted") {
		const subscription = event.data.object as Stripe.Subscription;
		if (await wakePhoneAddonFromSubscription(db, event, subscription, fence)) {
			return;
		}
		if (
			relayApiSubscriptionRole(subscription) !== STRIPE_SUBSCRIPTION_ROLES.base
		) {
			return;
		}
		let deletedOrganizationId: string | null = null;
		await db.transaction(async (tx) => {
			await assertStripeOrganizationFence(tx, fence);
			const [local] = await tx
				.select({
					id: organizationSubscriptions.id,
					organizationId: organizationSubscriptions.organizationId,
				})
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscription.id),
				)
				.limit(1);
			if (!local) return;
			if (fence && fence.organizationId !== local.organizationId) {
				throw new UnresolvedStripeEventError(
					`Subscription ${subscription.id} disagrees with its durable organization attribution`,
				);
			}
			deletedOrganizationId = local.organizationId;
			await tx
				.update(organizationSubscriptions)
				.set({
					status: "cancelled",
					stripeSubscriptionId: null,
					trialEndsAt: null,
					delinquentAt: null,
					graceEndsAt: null,
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				})
				.where(eq(organizationSubscriptions.id, local.id));
			await enqueueBillingEffects(tx, event.id, local.organizationId);
		});
		if (deletedOrganizationId) {
			await assertStripeOrganizationFence(db, fence);
			await shortenOpenBillingPeriod(db, {
				organizationId: deletedOrganizationId,
				effectiveAt: new Date(event.created * 1000),
				fence,
			});
		}
		return;
	}

	if (event.type === "invoice.created") {
		const snapshot = event.data.object as Stripe.Invoice;
		if (!fence) {
			throw new UnresolvedStripeEventError(
				`Invoice ${snapshot.id} has no organization fence`,
			);
		}
		await assertStripeOrganizationFence(db, fence);
		const canonicalInvoice = await stripe.invoices.retrieve(snapshot.id);
		// Only the short draft window is useful for attaching overage to the exact
		// renewal invoice. A delayed receipt is recovered by the durable catch-up
		// operation rather than guessing at another pending invoice.
		if (
			canonicalInvoice.status !== "draft" ||
			canonicalInvoice.billing_reason !== "subscription_cycle"
		) {
			return;
		}
		const subscriptionId = getInvoiceSubscriptionId(canonicalInvoice);
		if (!subscriptionId) {
			throw new UnresolvedStripeEventError(
				`Subscription-cycle invoice ${canonicalInvoice.id} has no subscription`,
			);
		}
		await assertStripeOrganizationFence(db, fence);
		const canonicalSubscription =
			await stripe.subscriptions.retrieve(subscriptionId);
		if (!isRelayApiBaseSubscription(canonicalSubscription)) {
			// Phone add-on and unrelated invoices never own base usage settlement.
			return;
		}
		const organizationId = fence.organizationId;
		await assertStripeOrganizationFence(db, fence);
		const lines = await listAllInvoiceLines(stripe, canonicalInvoice);
		const renewalBoundaries = [
			...new Set(
				lines
					.filter(
						(line) =>
							line.parent?.type === "subscription_item_details" &&
							line.parent.subscription_item_details?.proration === false,
					)
					.map((line) => line.period.start),
			),
		].map((timestamp) => new Date(timestamp * 1000));
		if (renewalBoundaries.length === 0) {
			throw new Error(
				`Invoice ${canonicalInvoice.id} has no renewal subscription line`,
			);
		}
		const candidates = await db
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.organizationId, organizationId),
					eq(billingPeriods.source, "stripe"),
					eq(billingPeriods.billable, true),
					eq(billingPeriods.releaseCount, 0),
					eq(billingPeriods.stripeSubscriptionId, subscriptionId),
					inArray(billingPeriods.periodEnd, renewalBoundaries),
					inArray(billingPeriods.state, [
						"open",
						"closed",
						"claimed",
						"settled",
					]),
				),
			)
			.orderBy(asc(billingPeriods.periodEnd), asc(billingPeriods.id))
			.limit(25);
		const exactPeriods = candidates.filter((period) =>
			lines.some((line) => invoiceLineMatchesBillingPeriod(line, period)),
		);
		if (exactPeriods.length > 1) {
			throw new UnresolvedStripeEventError(
				`Invoice ${canonicalInvoice.id} matches multiple billing periods`,
			);
		}
		const exactPeriod = exactPeriods[0];
		if (!exactPeriod) {
			// Checkout/subscription events can race invoice.created. Keep retrying
			// the durable receipt until the agreement projection is present.
			throw new Error(
				`Invoice ${canonicalInvoice.id} has no exact local billing period`,
			);
		}
		await assertStripeOrganizationFence(db, fence);
		if (exactPeriod.state === "open" || exactPeriod.state === "closed") {
			const claimed = await claimBillingPeriod(
				db,
				exactPeriod,
				{ kind: "cycle", stripeInvoiceId: canonicalInvoice.id },
				new Date(event.created * 1000),
				fence,
			);
			if (!claimed) {
				// A request still owns units in the closing period. Keep this receipt
				// retryable so the minute recovery sweep can attach the final amount
				// while Stripe's renewal invoice remains draft.
				throw new Error(
					`Billing period ${exactPeriod.id} still has unresolved usage reservations`,
				);
			}
		}
		await assertStripeOrganizationFence(db, fence);
		await processExactOverageBillingOperation(
			env,
			{
				operationId: `bop_${exactPeriod.id}_cycle`,
				organizationId,
				billingPeriodId: exactPeriod.id,
				organizationFence: fence,
			},
			db,
			stripe,
		);
		return;
	}

	if (
		event.type === "invoice.finalized" ||
		event.type === "invoice.paid" ||
		event.type === "invoice.payment_failed"
	) {
		const snapshot = event.data.object as Stripe.Invoice;
		const canonicalInvoice = await stripe.invoices.retrieve(snapshot.id);
		const billingSnapshot = await collectInvoiceBillingEvidence(
			stripe,
			canonicalInvoice,
		);
		const subscriptionId = getInvoiceSubscriptionId(canonicalInvoice);
		if (!subscriptionId) return;
		const invoiceCustomerId = stripeId(canonicalInvoice.customer);
		let canonicalSubscription: Stripe.Subscription | null = null;
		try {
			canonicalSubscription =
				await stripe.subscriptions.retrieve(subscriptionId);
		} catch (error) {
			const statusCode =
				error && typeof error === "object" && "statusCode" in error
					? (error as { statusCode?: number }).statusCode
					: undefined;
			if (statusCode !== 404) throw error;
		}
		if (
			canonicalSubscription &&
			(await wakePhoneAddonFromSubscription(
				db,
				event,
				canonicalSubscription,
				fence,
			))
		) {
			return;
		}
		if (
			canonicalSubscription &&
			!isRelayApiBaseSubscription(canonicalSubscription)
		) {
			// A phone add-on invoice is never a base-plan entitlement event.
			return;
		}

		let invoiceOrganizationId: string | null = null;
		let invoiceMatchesCurrentSubscription = false;
		await db.transaction(async (tx) => {
			await assertStripeOrganizationFence(tx, fence);
			const [subscriptionMatch] = await tx
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
				)
				.limit(1);
			const [customerMatch] = invoiceCustomerId
				? await tx
						.select()
						.from(organizationSubscriptions)
						.where(
							eq(organizationSubscriptions.stripeCustomerId, invoiceCustomerId),
						)
						.limit(1)
				: [];
			if (
				subscriptionMatch &&
				customerMatch &&
				subscriptionMatch.organizationId !== customerMatch.organizationId
			) {
				throw new UnresolvedStripeEventError(
					`Invoice ${canonicalInvoice.id} subscription and customer map to different organizations`,
				);
			}
			// Historical customer attribution is the fallback after churn; an exact
			// subscription match always wins when both identities agree.
			const local = subscriptionMatch ?? customerMatch;
			if (!local) return;
			if (fence && fence.organizationId !== local.organizationId) {
				throw new UnresolvedStripeEventError(
					`Invoice ${canonicalInvoice.id} disagrees with its durable organization attribution`,
				);
			}
			invoiceOrganizationId = local.organizationId;
			invoiceMatchesCurrentSubscription =
				local.stripeSubscriptionId === subscriptionId;

			const invoiceState = canonicalInvoiceStatus(canonicalInvoice);
			const finalizedAt =
				canonicalInvoice.status === "draft"
					? null
					: new Date(
							(canonicalInvoice.status_transitions?.finalized_at ??
								event.created) * 1000,
						);
			const firstPaymentFailedAt =
				event.type === "invoice.payment_failed"
					? new Date(event.created * 1000)
					: null;
			const [localInvoice] = await tx
				.insert(invoices)
				.values({
					organizationId: local.organizationId,
					status: invoiceState.status,
					periodStart: new Date(canonicalInvoice.period_start * 1000),
					periodEnd: new Date(canonicalInvoice.period_end * 1000),
					basePriceCents: billingSnapshot.basePriceCents,
					totalCents: canonicalInvoice.amount_due,
					currency: canonicalInvoice.currency,
					stripeInvoiceId: canonicalInvoice.id,
					stripeHostedUrl: canonicalInvoice.hosted_invoice_url ?? null,
					finalizedAt,
					firstPaymentFailedAt,
					paidAt: invoiceState.paidAt,
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: invoices.stripeInvoiceId,
					set: {
						status: invoiceState.status,
						basePriceCents: billingSnapshot.basePriceCents,
						totalCents: canonicalInvoice.amount_due,
						currency: canonicalInvoice.currency,
						stripeHostedUrl: canonicalInvoice.hosted_invoice_url ?? null,
						finalizedAt: sql`COALESCE(${invoices.finalizedAt}, ${finalizedAt})`,
						firstPaymentFailedAt: sql`COALESCE(${invoices.firstPaymentFailedAt}, ${firstPaymentFailedAt})`,
						paidAt: invoiceState.paidAt,
						updatedAt: new Date(),
					},
				})
				.returning({ id: invoices.id });

			if (localInvoice && billingSnapshot.evidence.length > 0) {
				await reconcileInvoiceBillingPeriods(tx, {
					invoiceId: localInvoice.id,
					stripeInvoiceId: canonicalInvoice.id,
					organizationId: local.organizationId,
					evidence: billingSnapshot.evidence,
					occurredAt: new Date(event.created * 1000),
				});
			}

			if (
				localInvoice &&
				event.type === "invoice.payment_failed" &&
				firstPaymentFailedAt
			) {
				const dayMs = 24 * 60 * 60 * 1000;
				for (const [kind, days] of [
					["reminder_1d", 1],
					["reminder_7d", 7],
					["deactivated_14d", 14],
				] as const) {
					const dueAt = new Date(firstPaymentFailedAt.getTime() + days * dayMs);
					const deliveryIdempotencyKey = `dunning:${localInvoice.id}:${kind}`;
					await tx
						.insert(dunningEvents)
						.values({
							organizationId: local.organizationId,
							invoiceId: localInvoice.id,
							stripeInvoiceId: canonicalInvoice.id,
							event: kind,
							deliveryIdempotencyKey,
							dueAt,
							nextAttemptAt: dueAt,
							deadlineAt: new Date(dueAt.getTime() + dayMs),
							...(kind === "deactivated_14d"
								? {
										deactivationStatus: "pending" as const,
										deactivationOperationId: `${deliveryIdempotencyKey}:stripe-cancel`,
									}
								: {}),
						})
						.onConflictDoNothing();
				}
			}

			if (canonicalSubscription && invoiceMatchesCurrentSubscription) {
				await tx
					.update(organizationSubscriptions)
					.set(subscriptionValues(canonicalSubscription))
					.where(eq(organizationSubscriptions.id, local.id));
			} else if (invoiceMatchesCurrentSubscription) {
				await tx
					.update(organizationSubscriptions)
					.set({
						status: "cancelled",
						stripeSubscriptionId: null,
						trialEndsAt: null,
						delinquentAt: null,
						graceEndsAt: null,
						updatedAt: new Date(),
					})
					.where(eq(organizationSubscriptions.id, local.id));
			}

			const canonicalStatus = canonicalSubscription
				? mapStripeSubscriptionStatus(canonicalSubscription.status)
				: "cancelled";
			await enqueueBillingEffects(tx, event.id, local.organizationId, {
				paymentFailedInvoiceId:
					event.type === "invoice.payment_failed" &&
					canonicalStatus === "past_due"
						? canonicalInvoice.id
						: undefined,
			});
		});
		if (invoiceOrganizationId && invoiceMatchesCurrentSubscription) {
			await assertStripeOrganizationFence(db, fence);
			const effectiveAt = new Date(event.created * 1000);
			const status = canonicalSubscription
				? mapStripeSubscriptionStatus(canonicalSubscription.status)
				: "cancelled";
			if (!canonicalSubscription || status === "cancelled") {
				await shortenOpenBillingPeriod(db, {
					organizationId: invoiceOrganizationId,
					effectiveAt,
					fence,
				});
			} else {
				await synchronizeStripeBillingPeriod(db, {
					organizationId: invoiceOrganizationId,
					subscription: canonicalSubscription,
					status,
					effectiveAt,
					fence,
				});
			}
		}
		return;
	}

	if (STRIPE_FINANCIAL_EVENTS.has(event.type)) {
		throw new UnresolvedStripeEventError(
			`Financial Stripe event ${event.type} has no implemented projection`,
		);
	}
}

async function claimStripeEvent(
	db: Database,
	eventId: string,
): Promise<{
	leaseToken: number;
	attempts: number;
	receivedAt: Date;
} | null> {
	const now = new Date();
	const ageCutoff = new Date(now.getTime() - STRIPE_RECOVERY_MAX_AGE_MS);
	const [claimed] = await db
		.update(stripeEvents)
		.set({
			status: "processing",
			attempts: sql`${stripeEvents.attempts} + 1`,
			leaseToken: sql`${stripeEvents.leaseToken} + 1`,
			leaseExpiresAt: new Date(Date.now() + EVENT_LEASE_MS),
			operatorRetryRequestedAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(stripeEvents.id, eventId),
				sql`${stripeEvents.attempts} < ${STRIPE_RECOVERY_MAX_ATTEMPTS}`,
				or(
					sql`${stripeEvents.receivedAt} > ${ageCutoff}`,
					isNotNull(stripeEvents.operatorRetryRequestedAt),
				),
				or(
					and(
						stripeEventAutomaticRecoveryStatus(),
						lte(stripeEvents.nextAttemptAt, now),
					),
					and(
						eq(stripeEvents.status, "processing"),
						lte(stripeEvents.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning({
			leaseToken: stripeEvents.leaseToken,
			attempts: stripeEvents.attempts,
			receivedAt: stripeEvents.receivedAt,
		});
	return claimed ?? null;
}

export async function processStripeEvent(
	event: Stripe.Event,
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
): Promise<"processed" | "already_claimed" | "manual_review"> {
	const claim = await claimStripeEvent(db, event.id);
	if (claim === null) return "already_claimed";
	const { leaseToken } = claim;
	let organizationFence: StripeOrganizationFence | null = null;
	try {
		let organizationId = await resolveStripeEventOrganizationId(db, event);
		if (organizationId) {
			await persistStripeEventOrganizationAttribution(db, {
				eventId: event.id,
				organizationId,
				leaseToken,
			});
			organizationFence = await claimStripeOrganizationFence(
				db,
				organizationId,
				event.id,
			);
			if (!organizationFence) {
				throw new Error(
					`Stripe organization ${organizationId} is processing another event`,
				);
			}
		}
		await handleEvent(event, env, db, organizationFence);
		// Some checkout events become attributable only after canonical Stripe
		// state has been projected. Capture that ownership before redacting the
		// payload, while the same receipt lease still fences the write.
		organizationId ??= await resolveStripeEventOrganizationId(db, event);
		if (organizationId) {
			await persistStripeEventOrganizationAttribution(db, {
				eventId: event.id,
				organizationId,
				leaseToken,
			});
		}
		const [completed] = await db
			.update(stripeEvents)
			.set({
				status: "succeeded",
				// The typed receipt columns are sufficient after successful processing;
				// avoid retaining a second, indefinite copy of the Stripe payload.
				payload: {},
				processedAt: new Date(),
				manualReviewAt: null,
				operatorRetryRequestedAt: null,
				leaseExpiresAt: null,
				lastError: null,
				lastErrorClass: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.status, "processing"),
					eq(stripeEvents.leaseToken, leaseToken),
				),
			)
			.returning({ id: stripeEvents.id });
		return completed ? "processed" : "already_claimed";
	} catch (error) {
		if (error instanceof UnresolvedStripeEventError) {
			const [parked] = await db
				.update(stripeEvents)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: error.message,
					lastErrorClass: "unresolved",
					manualReviewAt: new Date(),
					operatorRetryRequestedAt: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(stripeEvents.id, event.id),
						eq(stripeEvents.status, "processing"),
						eq(stripeEvents.leaseToken, leaseToken),
					),
				)
				.returning({ id: stripeEvents.id });
			return parked ? "manual_review" : "already_claimed";
		}
		const now = new Date();
		const errorClass = classifyStripeRecoveryError(error);
		const receivedAt =
			claim.receivedAt instanceof Date ? claim.receivedAt : now;
		const exhausted =
			claim.attempts >= STRIPE_RECOVERY_MAX_ATTEMPTS ||
			now.getTime() - receivedAt.getTime() >= STRIPE_RECOVERY_MAX_AGE_MS;
		const manualReview = errorClass === "permanent" || exhausted;
		const escalationClass =
			errorClass === "permanent"
				? "permanent"
				: claim.attempts >= STRIPE_RECOVERY_MAX_ATTEMPTS
					? "retry_exhausted"
					: "age_exhausted";
		const [transitioned] = await db
			.update(stripeEvents)
			.set({
				status: manualReview ? "manual_review" : "failed",
				nextAttemptAt: stripeEventRetryAt(claim.attempts, now),
				leaseExpiresAt: null,
				lastError: error instanceof Error ? error.message : String(error),
				lastErrorClass: manualReview ? escalationClass : "transient",
				manualReviewAt: manualReview ? now : null,
				operatorRetryRequestedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.status, "processing"),
					eq(stripeEvents.leaseToken, leaseToken),
				),
			)
			.returning({ id: stripeEvents.id });
		if (!transitioned) return "already_claimed";
		if (manualReview) return "manual_review";
		throw error;
	} finally {
		try {
			await releaseStripeOrganizationFence(db, organizationFence);
		} catch (error) {
			console.error("Failed to release Stripe organization aggregate lease", {
				eventId: event.id,
				organizationId: organizationFence?.organizationId,
				error,
			});
		}
	}
}

/** Cron recovery for receipts whose request worker died after durable accept. */
export async function processPendingStripeEvents(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const ageCutoff = new Date(now.getTime() - STRIPE_RECOVERY_MAX_AGE_MS);
	await db
		.update(stripeEvents)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			lastError: sql`COALESCE(${stripeEvents.lastError}, 'Stripe receipt exceeded automatic recovery policy')`,
			lastErrorClass: sql`CASE
				WHEN ${stripeEvents.attempts} >= ${STRIPE_RECOVERY_MAX_ATTEMPTS}
					THEN 'retry_exhausted'
				ELSE 'age_exhausted'
			END`,
			manualReviewAt: now,
			updatedAt: now,
		})
		.where(
			and(
				isNull(stripeEvents.operatorRetryRequestedAt),
				or(
					stripeEventAutomaticRecoveryStatus(),
					and(
						eq(stripeEvents.status, "processing"),
						lte(stripeEvents.leaseExpiresAt, now),
					),
				),
				or(
					sql`${stripeEvents.attempts} >= ${STRIPE_RECOVERY_MAX_ATTEMPTS}`,
					lte(stripeEvents.receivedAt, ageCutoff),
				),
			),
		);
	const rows = await db
		.select({ payload: stripeEvents.payload })
		.from(stripeEvents)
		.where(
			and(
				or(
					and(
						stripeEventAutomaticRecoveryStatus(),
						lte(stripeEvents.nextAttemptAt, now),
					),
					and(
						eq(stripeEvents.status, "processing"),
						lte(stripeEvents.leaseExpiresAt, now),
					),
				),
				sql`${stripeEvents.attempts} < ${STRIPE_RECOVERY_MAX_ATTEMPTS}`,
				or(
					sql`${stripeEvents.receivedAt} > ${ageCutoff}`,
					isNotNull(stripeEvents.operatorRetryRequestedAt),
				),
			),
		)
		.orderBy(
			asc(stripeEvents.nextAttemptAt),
			asc(stripeEvents.receivedAt),
			asc(stripeEvents.id),
		)
		.limit(25);
	let processed = 0;
	for (const row of rows) {
		try {
			const result = await processStripeEvent(
				row.payload as unknown as Stripe.Event,
				env,
				db,
			);
			if (result === "processed") processed++;
		} catch (error) {
			console.error("Stripe receipt recovery failed", error);
		}
	}
	return processed;
}

app.post("/", async (c) => {
	const signature = c.req.header("stripe-signature");
	if (!signature) return c.json({ error: "Missing signature" }, 400);
	let body: string;
	try {
		body = await readRequestText(c.req.raw, MAX_STRIPE_WEBHOOK_BYTES);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return c.json({ error: "Payload too large" }, 413);
		}
		throw error;
	}
	const stripe = await createStripeClient(c.env.STRIPE_SECRET_KEY);

	let event: Stripe.Event;
	try {
		event = await stripe.webhooks.constructEventAsync(
			body,
			signature,
			c.env.STRIPE_WEBHOOK_SECRET,
		);
	} catch (error) {
		console.error("Stripe webhook signature verification failed", error);
		return c.json({ error: "Invalid signature" }, 400);
	}

	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const object = event.data.object as { id?: string };
	const sourceDigest = await digestFinancialExternalSourceId(
		"stripe",
		event.id,
	);
	const acceptance = await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(
				hashtextextended(${financialStripeEventAdvisoryLockKey(sourceDigest)}, 0)
			)`,
		);
		const [retained] = await tx
			.select({ id: financialRetentionReceipts.id })
			.from(financialRetentionReceipts)
			.where(
				and(
					eq(financialRetentionReceipts.sourceKind, "stripe_event_global"),
					eq(financialRetentionReceipts.sourceId, sourceDigest),
					gt(financialRetentionReceipts.retainedUntil, new Date()),
				),
			)
			.limit(1);
		if (retained) return { duplicate: true, existingStatus: null };

		const inserted = await tx
			.insert(stripeEvents)
			.values({
				id: event.id,
				type: event.type,
				objectId: object.id ?? null,
				customerId: eventCustomerId(event),
				subscriptionId: eventSubscriptionId(event),
				payload: event as unknown as Record<string, unknown>,
				stripeCreatedAt: new Date(event.created * 1000),
			})
			.onConflictDoNothing()
			.returning({ id: stripeEvents.id });
		if (inserted.length > 0) {
			return { duplicate: false, existingStatus: null };
		}
		const [existing] = await tx
			.select({ status: stripeEvents.status })
			.from(stripeEvents)
			.where(eq(stripeEvents.id, event.id))
			.limit(1);
		return {
			duplicate: existing?.status === "succeeded",
			existingStatus: existing?.status ?? null,
		};
	});

	if (acceptance.duplicate) {
		return c.json({ received: true, duplicate: true });
	}

	// The committed Postgres receipt is the recovery authority. This immediate
	// attempt only reduces latency; a Worker termination cannot lose the event
	// because the minute recovery sweep owns the same durable row for 30 days.
	c.executionCtx.waitUntil(
		processStripeEvent(event, c.env, db).catch((error) => {
			console.error(
				"Stripe webhook prompt processing failed; receipt remains durable",
				event.type,
				event.id,
				error,
			);
		}),
	);
	return c.json({ received: true, queued: true });
});

export default app;
