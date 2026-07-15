import {
	billingOperations,
	billingOutbox,
	createDb,
	type Database,
	invoices,
	organizationSubscriptions,
	stripeEvents,
	subscriptionCheckoutOperations,
	usageBucketSettlements,
	usageBuckets,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import {
	ResponseTooLargeError,
	readRequestText,
} from "../lib/fetch-public-url";
import { createStripeClient } from "../services/stripe";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();
const EVENT_LEASE_MS = 5 * 60 * 1000;
export const MAX_STRIPE_WEBHOOK_BYTES = 1024 * 1024;

class UnresolvedStripeEventError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnresolvedStripeEventError";
	}
}

type LocalSubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";

export function mapStripeSubscriptionStatus(
	status: Stripe.Subscription.Status,
): LocalSubscriptionStatus {
	switch (status) {
		case "active":
			return "active";
		case "trialing":
			return "trialing";
		case "past_due":
		case "unpaid":
			return "past_due";
		default:
			return "cancelled";
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
	return {
		status: mapStripeSubscriptionStatus(subscription.status),
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

function eventSubscriptionId(event: Stripe.Event): string | null {
	const object = event.data.object;
	if (event.type.startsWith("customer.subscription.")) {
		return (object as Stripe.Subscription).id;
	}
	if (event.type.startsWith("invoice.")) {
		return getInvoiceSubscriptionId(object as Stripe.Invoice);
	}
	if (event.type === "checkout.session.completed") {
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
	invoiceItemId: string | null;
};

async function collectInvoiceBillingEvidence(
	stripe: Stripe,
	invoice: Stripe.Invoice,
): Promise<InvoiceBillingEvidence[]> {
	let lines = invoice.lines?.data ?? [];
	if (invoice.lines?.has_more) {
		lines = [];
		for await (const line of stripe.invoices.listLineItems(invoice.id, {
			limit: 100,
		})) {
			lines.push(line);
		}
	}
	return lines.flatMap((line) => {
		const operationId = line.metadata?.relayapi_operation_id ?? null;
		const invoiceItemId =
			line.parent?.invoice_item_details?.invoice_item ?? null;
		return operationId || invoiceItemId ? [{ operationId, invoiceItemId }] : [];
	});
}

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function reconcileInvoiceUsageSettlements(
	tx: BillingTransaction,
	input: {
		invoiceId: string;
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
		const providerEvidence = input.evidence.find(
			(item) =>
				item.operationId === operation.id ||
				item.invoiceItemId === operation.stripeInvoiceItemId,
		);
		await tx
			.update(billingOperations)
			.set({
				status: "succeeded",
				stripeInvoiceItemId:
					providerEvidence?.invoiceItemId ?? operation.stripeInvoiceItemId,
				leaseExpiresAt: null,
				lastError: null,
				completedAt: sql`COALESCE(${billingOperations.completedAt}, ${input.occurredAt})`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(billingOperations.id, operation.id),
					eq(billingOperations.organizationId, input.organizationId),
				),
			);
		await tx
			.update(usageBucketSettlements)
			.set({
				state: "settled",
				invoiceId: input.invoiceId,
				settledAt: input.occurredAt,
				revision: sql`${usageBucketSettlements.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(usageBucketSettlements.id, operation.usageBucketSettlementId),
					eq(usageBucketSettlements.organizationId, input.organizationId),
					eq(usageBucketSettlements.state, "claimed"),
				),
			);
	}

	const [usageSummary] = await tx
		.select({
			committedUnits: sql<number>`COALESCE(SUM(${usageBucketSettlements.committedUnitsSnapshot}), 0)::integer`,
			includedUnits: sql<number>`COALESCE(SUM(${usageBuckets.includedUnits}), 0)::integer`,
			amountCents: sql<number>`COALESCE(SUM(${usageBucketSettlements.amountCents}), 0)::integer`,
		})
		.from(usageBucketSettlements)
		.innerJoin(
			usageBuckets,
			and(
				eq(usageBuckets.id, usageBucketSettlements.bucketId),
				eq(usageBuckets.organizationId, usageBucketSettlements.organizationId),
			),
		)
		.where(
			and(
				eq(usageBucketSettlements.invoiceId, input.invoiceId),
				eq(usageBucketSettlements.organizationId, input.organizationId),
			),
		);
	if (!usageSummary) return;
	await tx
		.update(invoices)
		.set({
			apiCallsCount: usageSummary.committedUnits,
			apiCallsIncluded: usageSummary.includedUnits,
			overageCalls: Math.max(
				0,
				usageSummary.committedUnits - usageSummary.includedUnits,
			),
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
): Promise<void> {
	const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);

	if (event.type === "checkout.session.completed") {
		const session = event.data.object as Stripe.Checkout.Session;
		if (session.mode !== "subscription" || !session.subscription) return;
		const subscription = await stripe.subscriptions.retrieve(
			stripeId(session.subscription) as string,
		);

		if (session.metadata?.type === "wa_phone_number") {
			const phoneNumberId = session.metadata.phoneNumberId;
			const firstItem = subscription.items?.data?.[0];
			if (phoneNumberId && firstItem) {
				await db
					.update(whatsappPhoneNumbers)
					.set({
						stripeSubscriptionItemId: firstItem.id,
						updatedAt: new Date(),
					})
					.where(eq(whatsappPhoneNumbers.id, phoneNumberId));
			}
			return;
		}

		let organizationId =
			session.metadata?.organizationId ||
			subscription.metadata?.organizationId ||
			null;
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
			console.error("checkout.session.completed: cannot resolve organization", {
				eventId: event.id,
				sessionId: session.id,
			});
			throw new UnresolvedStripeEventError(
				"checkout session could not be mapped to an organization",
			);
		}

		await db.transaction(async (tx) => {
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
		return;
	}

	if (event.type === "customer.subscription.updated") {
		const snapshot = event.data.object as Stripe.Subscription;
		const canonical = await stripe.subscriptions.retrieve(snapshot.id);
		await db.transaction(async (tx) => {
			const [local] = await tx
				.select({
					id: organizationSubscriptions.id,
					organizationId: organizationSubscriptions.organizationId,
				})
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.stripeSubscriptionId, canonical.id))
				.limit(1);
			if (!local) return;
			await tx
				.update(organizationSubscriptions)
				.set(subscriptionValues(canonical))
				.where(eq(organizationSubscriptions.id, local.id));
			await enqueueBillingEffects(tx, event.id, local.organizationId);
		});
		return;
	}

	if (event.type === "customer.subscription.deleted") {
		const subscription = event.data.object as Stripe.Subscription;
		await db.transaction(async (tx) => {
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
			await tx
				.update(organizationSubscriptions)
				.set({
					status: "cancelled",
					stripeSubscriptionId: null,
					trialEndsAt: null,
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				})
				.where(eq(organizationSubscriptions.id, local.id));
			await enqueueBillingEffects(tx, event.id, local.organizationId);
		});
		return;
	}

	if (
		event.type === "invoice.finalized" ||
		event.type === "invoice.paid" ||
		event.type === "invoice.payment_failed"
	) {
		const snapshot = event.data.object as Stripe.Invoice;
		const canonicalInvoice = await stripe.invoices.retrieve(snapshot.id);
		const billingEvidence = await collectInvoiceBillingEvidence(
			stripe,
			canonicalInvoice,
		);
		const subscriptionId = getInvoiceSubscriptionId(canonicalInvoice);
		if (!subscriptionId) return;
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

		await db.transaction(async (tx) => {
			const [local] = await tx
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
				)
				.limit(1);
			if (!local) return;

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
					basePriceCents: local.monthlyPriceCents,
					totalCents: canonicalInvoice.amount_due,
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
						totalCents: canonicalInvoice.amount_due,
						stripeHostedUrl: canonicalInvoice.hosted_invoice_url ?? null,
						finalizedAt: sql`COALESCE(${invoices.finalizedAt}, ${finalizedAt})`,
						firstPaymentFailedAt: sql`COALESCE(${invoices.firstPaymentFailedAt}, ${firstPaymentFailedAt})`,
						paidAt: invoiceState.paidAt,
						updatedAt: new Date(),
					},
				})
				.returning({ id: invoices.id });

			if (localInvoice && billingEvidence.length > 0) {
				await reconcileInvoiceUsageSettlements(tx, {
					invoiceId: localInvoice.id,
					organizationId: local.organizationId,
					evidence: billingEvidence,
					occurredAt: new Date(event.created * 1000),
				});
			}

			if (canonicalSubscription) {
				await tx
					.update(organizationSubscriptions)
					.set(subscriptionValues(canonicalSubscription))
					.where(eq(organizationSubscriptions.id, local.id));
			} else {
				await tx
					.update(organizationSubscriptions)
					.set({
						status: "cancelled",
						stripeSubscriptionId: null,
						trialEndsAt: null,
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
	}
}

async function claimStripeEvent(
	db: Database,
	eventId: string,
): Promise<number | null> {
	const now = new Date();
	const [claimed] = await db
		.update(stripeEvents)
		.set({
			status: "processing",
			attempts: sql`${stripeEvents.attempts} + 1`,
			leaseToken: sql`${stripeEvents.leaseToken} + 1`,
			leaseExpiresAt: new Date(Date.now() + EVENT_LEASE_MS),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(stripeEvents.id, eventId),
				or(
					inArray(stripeEvents.status, ["pending", "failed"]),
					and(
						eq(stripeEvents.status, "processing"),
						lte(stripeEvents.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning({ leaseToken: stripeEvents.leaseToken });
	return claimed?.leaseToken ?? null;
}

export async function processStripeEvent(
	event: Stripe.Event,
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
): Promise<"processed" | "already_claimed" | "manual_review"> {
	const leaseToken = await claimStripeEvent(db, event.id);
	if (leaseToken === null) return "already_claimed";
	try {
		await handleEvent(event, env, db);
		await db
			.update(stripeEvents)
			.set({
				status: "succeeded",
				// The typed receipt columns are sufficient after successful processing;
				// avoid retaining a second, indefinite copy of the Stripe payload.
				payload: {},
				processedAt: new Date(),
				leaseExpiresAt: null,
				lastError: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.status, "processing"),
					eq(stripeEvents.leaseToken, leaseToken),
				),
			);
		return "processed";
	} catch (error) {
		if (error instanceof UnresolvedStripeEventError) {
			await db
				.update(stripeEvents)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: error.message,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(stripeEvents.id, event.id),
						eq(stripeEvents.status, "processing"),
						eq(stripeEvents.leaseToken, leaseToken),
					),
				);
			return "manual_review";
		}
		await db
			.update(stripeEvents)
			.set({
				status: "failed",
				leaseExpiresAt: null,
				lastError: error instanceof Error ? error.message : String(error),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(stripeEvents.id, event.id),
					eq(stripeEvents.status, "processing"),
					eq(stripeEvents.leaseToken, leaseToken),
				),
			);
		throw error;
	}
}

/** Cron recovery for receipts whose request worker died after durable accept. */
export async function processPendingStripeEvents(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const rows = await db
		.select({ payload: stripeEvents.payload })
		.from(stripeEvents)
		.where(
			or(
				inArray(stripeEvents.status, ["pending", "failed"]),
				and(
					eq(stripeEvents.status, "processing"),
					lte(stripeEvents.leaseExpiresAt, now),
				),
			),
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
	const inserted = await db
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

	if (inserted.length === 0) {
		const [existing] = await db
			.select({ status: stripeEvents.status })
			.from(stripeEvents)
			.where(eq(stripeEvents.id, event.id))
			.limit(1);
		if (existing?.status === "succeeded") {
			return c.json({ received: true, duplicate: true });
		}
	}

	try {
		const result = await processStripeEvent(event, c.env, db);
		return c.json({
			received: true,
			processing: result === "already_claimed",
			manual_review: result === "manual_review",
		});
	} catch (error) {
		console.error(
			"Stripe webhook processing failed",
			event.type,
			event.id,
			error,
		);
		return c.json({ error: "Webhook handler failed" }, 500);
	}
});

export default app;
