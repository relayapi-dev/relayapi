import {
	createDb,
	dunningEvents,
	invoices,
	member,
	organization,
	organizationSubscriptions,
	user,
} from "@relayapi/db";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type Stripe from "stripe";
import type { Env } from "../types";
import { sendPaymentFailedReminder, sendPlanDeactivatedEmail } from "./email";
import { createStripeClient } from "./stripe";

type DunningEventKind = "reminder_1d" | "reminder_7d" | "deactivated_14d";
type DunningRow = typeof dunningEvents.$inferSelect;

const DUNNING_LEASE_MS = 5 * 60 * 1000;
const MAX_DUNNING_ATTEMPTS = 8;
const BASE_RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

function stripeStatusCode(error: unknown): number | undefined {
	return error && typeof error === "object" && "statusCode" in error
		? (error as { statusCode?: number }).statusCode
		: undefined;
}

function subscriptionEvidence(subscription: Stripe.Subscription) {
	return {
		id: subscription.id,
		status: subscription.status,
		canceled_at: subscription.canceled_at,
	};
}

function retryAt(attempts: number, now: Date): Date {
	const delay = Math.min(
		BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1),
		MAX_RETRY_MS,
	);
	return new Date(now.getTime() + delay);
}

async function ensureDunningEvent(
	db: ReturnType<typeof createDb>,
	input: {
		organizationId: string;
		invoiceId: string;
		stripeInvoiceId: string | null;
		event: DunningEventKind;
	},
): Promise<void> {
	const deliveryIdempotencyKey = `dunning:${input.invoiceId}:${input.event}`;
	await db
		.insert(dunningEvents)
		.values({
			organizationId: input.organizationId,
			invoiceId: input.invoiceId,
			stripeInvoiceId: input.stripeInvoiceId,
			event: input.event,
			deliveryIdempotencyKey,
			...(input.event === "deactivated_14d"
				? {
						deactivationStatus: "pending" as const,
						deactivationOperationId: `${deliveryIdempotencyKey}:stripe-cancel`,
					}
				: {}),
		})
		.onConflictDoNothing();
}

async function claimDunningEvent(
	db: ReturnType<typeof createDb>,
	invoiceId: string,
	event: DunningEventKind,
	now: Date,
): Promise<DunningRow | null> {
	const leaseExpiresAt = new Date(now.getTime() + DUNNING_LEASE_MS);
	const staleBefore = now;
	const [claimed] = await db
		.update(dunningEvents)
		.set({
			status: "processing",
			attempts: sql`${dunningEvents.attempts} + 1`,
			leaseToken: sql`${dunningEvents.leaseToken} + 1`,
			claimedAt: now,
			leaseExpiresAt,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(dunningEvents.invoiceId, invoiceId),
				eq(dunningEvents.event, event),
				or(
					and(
						inArray(dunningEvents.status, ["pending", "failed"]),
						lte(dunningEvents.nextAttemptAt, now),
					),
					and(
						eq(dunningEvents.status, "processing"),
						or(
							isNull(dunningEvents.leaseExpiresAt),
							lt(dunningEvents.leaseExpiresAt, staleBefore),
						),
					),
				),
			),
		)
		.returning();
	return claimed ?? null;
}

function claimFence(row: DunningRow) {
	return and(
		eq(dunningEvents.id, row.id),
		eq(dunningEvents.status, "processing"),
		eq(dunningEvents.leaseToken, row.leaseToken),
	);
}

async function markDunningSent(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
): Promise<void> {
	const now = new Date();
	await db
		.update(dunningEvents)
		.set({
			status: "sent",
			sentAt: now,
			leaseExpiresAt: null,
			lastError: null,
			updatedAt: now,
		})
		.where(claimFence(row));
}

async function markDunningFailure(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	error: unknown,
	options?: { terminal?: boolean; deactivationFailed?: boolean },
): Promise<void> {
	const now = new Date();
	const message = error instanceof Error ? error.message : String(error);
	const terminal = options?.terminal || row.attempts >= MAX_DUNNING_ATTEMPTS;
	await db
		.update(dunningEvents)
		.set({
			status: terminal ? "terminal_failed" : "failed",
			nextAttemptAt: retryAt(row.attempts, now),
			leaseExpiresAt: null,
			lastError: message,
			updatedAt: now,
			...(options?.deactivationFailed
				? {
						deactivationStatus: terminal
							? ("manual_review" as const)
							: ("failed" as const),
						deactivationLastError: message,
					}
				: {}),
		})
		.where(claimFence(row));
}

async function markDeactivationSucceeded(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	evidence: ReturnType<typeof subscriptionEvidence> | { status: "not_found" },
): Promise<boolean> {
	const now = new Date();
	const updated = await db
		.update(dunningEvents)
		.set({
			deactivationStatus: "succeeded",
			deactivationConfirmedAt: now,
			deactivationProviderResponse: evidence,
			deactivationLastError: null,
			updatedAt: now,
		})
		.where(claimFence(row))
		.returning({ id: dunningEvents.id });
	return updated.length > 0;
}

async function parkAmbiguousDeactivation(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	error: unknown,
): Promise<void> {
	const now = new Date();
	const message = error instanceof Error ? error.message : String(error);
	await db
		.update(dunningEvents)
		.set({
			status: "terminal_failed",
			deactivationStatus: "manual_review",
			deactivationLastError: message,
			lastError: message,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(claimFence(row));
}

/**
 * Return true only after the provider's canonical state proves cancellation.
 * A crash after the external call is recovered by the next lease holder's
 * retrieve-before-cancel check. If that reconciliation is itself unavailable,
 * the operation is parked instead of blindly issuing another cancellation.
 */
async function ensureSubscriptionDeactivated(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	stripe: Stripe,
	stripeSubscriptionId: string,
): Promise<boolean> {
	if (row.deactivationStatus === "succeeded") return true;

	let canonical: Stripe.Subscription;
	try {
		canonical = await stripe.subscriptions.retrieve(stripeSubscriptionId);
	} catch (error) {
		if (stripeStatusCode(error) === 404) {
			return markDeactivationSucceeded(db, row, { status: "not_found" });
		}
		await markDunningFailure(db, row, error, { deactivationFailed: true });
		return false;
	}
	if (canonical.status === "canceled") {
		return markDeactivationSucceeded(db, row, subscriptionEvidence(canonical));
	}

	const requestedAt = new Date();
	const staged = await db
		.update(dunningEvents)
		.set({
			deactivationStatus: "processing",
			deactivationRequestedAt: requestedAt,
			deactivationLastError: null,
			updatedAt: requestedAt,
		})
		.where(claimFence(row))
		.returning({ id: dunningEvents.id });
	if (staged.length === 0) return false;

	try {
		const canceled = await stripe.subscriptions.cancel(
			stripeSubscriptionId,
			{},
			{ idempotencyKey: row.deactivationOperationId ?? undefined },
		);
		return markDeactivationSucceeded(db, row, subscriptionEvidence(canceled));
	} catch (cancelError) {
		try {
			const reconciled =
				await stripe.subscriptions.retrieve(stripeSubscriptionId);
			if (reconciled.status === "canceled") {
				return markDeactivationSucceeded(
					db,
					row,
					subscriptionEvidence(reconciled),
				);
			}
			await markDunningFailure(db, row, cancelError, {
				deactivationFailed: true,
			});
			return false;
		} catch (reconcileError) {
			if (stripeStatusCode(reconcileError) === 404) {
				return markDeactivationSucceeded(db, row, { status: "not_found" });
			}
			await parkAmbiguousDeactivation(
				db,
				row,
				new AggregateError(
					[cancelError, reconcileError],
					"Stripe cancellation outcome could not be reconciled",
				),
			);
			return false;
		}
	}
}

async function deliverDunningEvent(
	db: ReturnType<typeof createDb>,
	env: Env,
	row: DunningRow,
	context: {
		billingEmail: string | null;
		orgName: string;
		invoiceUrl: string | null;
		stripeSubscriptionId: string | null;
	},
): Promise<void> {
	try {
		if (row.event === "deactivated_14d") {
			if (!context.stripeSubscriptionId) {
				await markDunningFailure(
					db,
					row,
					"Stripe subscription ID is missing; deactivation requires manual review",
					{ terminal: true, deactivationFailed: true },
				);
				return;
			}
			const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
			const deactivated = await ensureSubscriptionDeactivated(
				db,
				row,
				stripe,
				context.stripeSubscriptionId,
			);
			if (!deactivated) return;
		}

		if (!context.billingEmail) {
			await markDunningFailure(db, row, "Organization owner email is missing");
			return;
		}
		if (row.event === "deactivated_14d") {
			await sendPlanDeactivatedEmail(env.EMAIL_QUEUE, env.RESEND_API_KEY, {
				organizationId: row.organizationId,
				to: context.billingEmail,
				orgName: context.orgName,
				idempotencyKey: row.deliveryIdempotencyKey,
			});
		} else {
			await sendPaymentFailedReminder(env.EMAIL_QUEUE, env.RESEND_API_KEY, {
				organizationId: row.organizationId,
				to: context.billingEmail,
				orgName: context.orgName,
				invoiceUrl: context.invoiceUrl,
				portalUrl: "https://relayapi.dev/app/billing",
				isSecondReminder: row.event === "reminder_7d",
				idempotencyKey: row.deliveryIdempotencyKey,
			});
		}
		await markDunningSent(db, row);
	} catch (error) {
		await markDunningFailure(db, row, error);
	}
}

/**
 * Discover due payment-failure actions, persist their durable identities, and
 * claim each side effect before delivery. Safe under overlapping cron runs.
 */
export async function processDunning(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const pastDueSubs = await db
		.select({
			orgId: organizationSubscriptions.organizationId,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.status, "past_due"))
		.limit(100);

	for (const sub of pastDueSubs) {
		try {
			const [unpaidInvoice] = await db
				.select()
				.from(invoices)
				.where(
					and(
						eq(invoices.organizationId, sub.orgId),
						eq(invoices.status, "finalized"),
						isNull(invoices.paidAt),
						isNotNull(invoices.firstPaymentFailedAt),
					),
				)
				.orderBy(desc(invoices.firstPaymentFailedAt))
				.limit(1);
			if (!unpaidInvoice?.firstPaymentFailedAt) continue;

			const daysSinceFailure = Math.floor(
				(now.getTime() - unpaidInvoice.firstPaymentFailedAt.getTime()) /
					(24 * 60 * 60 * 1000),
			);
			const dueEvents: DunningEventKind[] = [];
			if (daysSinceFailure >= 1) dueEvents.push("reminder_1d");
			if (daysSinceFailure >= 7) dueEvents.push("reminder_7d");
			if (daysSinceFailure >= 14) dueEvents.push("deactivated_14d");
			if (dueEvents.length === 0) continue;

			const [billingEmail, org] = await Promise.all([
				getOrgOwnerEmail(db, sub.orgId),
				db
					.select({ name: organization.name })
					.from(organization)
					.where(eq(organization.id, sub.orgId))
					.limit(1)
					.then((rows) => rows[0]),
			]);

			for (const event of dueEvents) {
				await ensureDunningEvent(db, {
					organizationId: sub.orgId,
					invoiceId: unpaidInvoice.id,
					stripeInvoiceId: unpaidInvoice.stripeInvoiceId,
					event,
				});
				const claimed = await claimDunningEvent(
					db,
					unpaidInvoice.id,
					event,
					now,
				);
				if (!claimed) continue;
				await deliverDunningEvent(db, env, claimed, {
					billingEmail,
					orgName: org?.name || "your organization",
					invoiceUrl: unpaidInvoice.stripeHostedUrl,
					stripeSubscriptionId: sub.stripeSubscriptionId,
				});
			}
		} catch (error) {
			console.error(`Dunning failed for org ${sub.orgId}:`, error);
		}
	}
}

async function getOrgOwnerEmail(
	db: ReturnType<typeof createDb>,
	orgId: string,
): Promise<string | null> {
	const [ownerMember] = await db
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(and(eq(member.organizationId, orgId), eq(member.role, "owner")))
		.limit(1);
	return ownerMember?.email ?? null;
}
