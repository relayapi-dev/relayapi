import { hasOrganizationRole, PRICING } from "@relayapi/config";
import {
	createDb,
	dunningEvents,
	invoices,
	member,
	organization,
	organizationSubscriptions,
	user,
} from "@relayapi/db";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import {
	BASE_PRICE_TAX_BEHAVIOR,
	BASE_PRICE_TAX_CODE,
	BILLING_RATE_CARD_VERSION,
	OVERAGE_DISCOUNTABLE,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import type { Env } from "../types";
import { recoverStripeBillingAuthority } from "./billing-periods";
import { sendPaymentFailedReminder, sendPlanDeactivatedEmail } from "./email";
import { createStripeClient } from "./stripe";
import {
	assertStripeOrganizationFence,
	claimStripeOrganizationFence,
	releaseStripeOrganizationFence,
	type StripeOrganizationFence,
} from "./stripe-organization-lease";
import {
	isRelayApiBaseSubscription,
	mapStripeSubscriptionStatus,
} from "./stripe-subscriptions";

type DunningRow = typeof dunningEvents.$inferSelect;

const DUNNING_LEASE_MS = 5 * 60 * 1000;
const MAX_DUNNING_ATTEMPTS = 8;
export const DUNNING_DEACTIVATION_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;
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

type DeactivationEvidence =
	| (ReturnType<typeof subscriptionEvidence> & {
			action?:
				| "canceled"
				| "already_inactive"
				| "skipped_recovered"
				| "skipped_superseded";
	  })
	| {
			status: "not_found";
			action: "already_inactive" | "skipped_superseded";
	  }
	| {
			id: string;
			status: "superseded";
			action: "skipped_superseded";
	  };

type DeactivationOutcome = "deactivated" | "recovered";

function stripeId(value: string | { id: string } | null | undefined) {
	return typeof value === "string" ? value : (value?.id ?? null);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	return stripeId(invoice.parent?.subscription_details?.subscription);
}

export function recoveredSubscriptionProjection(
	subscription: Stripe.Subscription,
	now = new Date(),
) {
	if (
		canonicalDunningDecision(subscription.status) !== "recovered" ||
		!isRelayApiBaseSubscription(subscription)
	) {
		return null;
	}
	const period = subscription.items.data[0];
	const customerId = stripeId(subscription.customer);
	if (!period || !customerId) return null;
	const status: "active" | "trialing" =
		subscription.status === "trialing" ? "trialing" : "active";
	return {
		status,
		source: "stripe" as const,
		delinquentAt: null,
		graceEndsAt: null,
		stripeCustomerId: customerId,
		stripeSubscriptionId: subscription.id,
		trialEndsAt: subscription.trial_end
			? new Date(subscription.trial_end * 1000)
			: null,
		cancelAtPeriodEnd:
			subscription.cancel_at_period_end || Boolean(subscription.cancel_at),
		currentPeriodStart: new Date(period.current_period_start * 1000),
		currentPeriodEnd: new Date(period.current_period_end * 1000),
		updatedAt: now,
	};
}

function recoveredStripeBillingTerms(subscription: Stripe.Subscription) {
	if (!isRelayApiBaseSubscription(subscription)) {
		throw new Error(
			`Recovered subscription ${subscription.id} is not a RelayAPI base subscription`,
		);
	}
	const price = subscription.items.data[0]?.price;
	const customerId = stripeId(subscription.customer);
	const productId = price ? stripeId(price.product) : null;
	if (!price || !customerId || !productId) {
		throw new Error(
			"Recovered base subscription lacks immutable customer/product/price identity",
		);
	}
	if (price.currency !== "usd") {
		throw new Error(
			`Recovered base subscription currency is ${price.currency}`,
		);
	}
	const status = mapStripeSubscriptionStatus(subscription.status);
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
		basePriceCents: price.unit_amount ?? 0,
		currency: "usd" as const,
	};
}

export function canonicalDunningDecision(
	status: Stripe.Subscription.Status,
): "cancel" | "recovered" | "already_inactive" | "manual_review" {
	if (status === "active" || status === "trialing") return "recovered";
	if (status === "canceled" || status === "incomplete_expired") {
		return "already_inactive";
	}
	if (status === "past_due" || status === "unpaid") return "cancel";
	return "manual_review";
}

function retryAt(attempts: number, now: Date): Date {
	const delay = Math.min(
		BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1),
		MAX_RETRY_MS,
	);
	return new Date(now.getTime() + delay);
}

export function dunningDeactivationNeedsManualReview(
	createdAt: Date,
	now: Date,
): boolean {
	return (
		now.getTime() - createdAt.getTime() >= DUNNING_DEACTIVATION_RECOVERY_MS
	);
}

async function claimDunningEvent(
	db: ReturnType<typeof createDb>,
	id: string,
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
				eq(dunningEvents.id, id),
				lte(dunningEvents.dueAt, now),
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
	const terminal =
		options?.terminal ||
		(options?.deactivationFailed
			? dunningDeactivationNeedsManualReview(row.createdAt, now)
			: row.attempts >= MAX_DUNNING_ATTEMPTS);
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
						deactivationConfirmedAt: null,
						deactivationLastError: message,
					}
				: {}),
		})
		.where(claimFence(row));
}

async function markDeactivationSucceeded(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	evidence: DeactivationEvidence,
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
	requestBoundaryAt = row.deactivationRequestedAt,
): Promise<void> {
	const now = new Date();
	const message = error instanceof Error ? error.message : String(error);
	const horizonExhausted = dunningDeactivationNeedsManualReview(
		row.createdAt,
		now,
	);
	await db
		.update(dunningEvents)
		.set({
			status: horizonExhausted ? "terminal_failed" : "failed",
			nextAttemptAt: retryAt(row.attempts, now),
			deactivationStatus: horizonExhausted ? "manual_review" : "unknown",
			deactivationProviderResponse: horizonExhausted
				? {
						schema_version: 1,
						policy: "ambiguous_stripe_cancellation_30_day_horizon_v1",
						decision: "park_for_manual_resolution",
						owner: "dunning_recovery",
						dunning_event_id: row.id,
						operation_id: row.deactivationOperationId,
						request_boundary_at: requestBoundaryAt?.toISOString() ?? null,
						horizon_exhausted_at: now.toISOString(),
					}
				: {
						schema_version: 1,
						policy: "ambiguous_stripe_cancellation_30_day_horizon_v1",
						decision: "retry_reconciliation",
						operation_id: row.deactivationOperationId,
						next_attempt_at: retryAt(row.attempts, now).toISOString(),
					},
			deactivationLastError: message,
			lastError: message,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(claimFence(row));
}

/**
 * Return an outcome only after the provider's canonical state proves it.
 * A crash after the external call is recovered by the next lease holder's
 * retrieve-before-cancel check. If that reconciliation is itself unavailable,
 * the operation is parked instead of blindly issuing another cancellation.
 */
async function ensureSubscriptionDeactivated(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	stripe: Stripe,
	stripeSubscriptionId: string,
): Promise<DeactivationOutcome | null> {
	if (row.deactivationStatus === "succeeded") {
		const priorEvidence = row.deactivationProviderResponse as {
			action?: string;
		} | null;
		return priorEvidence?.action === "skipped_recovered"
			? "recovered"
			: "deactivated";
	}

	let canonical: Stripe.Subscription;
	try {
		canonical = await stripe.subscriptions.retrieve(stripeSubscriptionId);
	} catch (error) {
		if (stripeStatusCode(error) === 404) {
			return (await markDeactivationSucceeded(db, row, {
				status: "not_found",
				action: "already_inactive",
			}))
				? "deactivated"
				: null;
		}
		await markDunningFailure(db, row, error, { deactivationFailed: true });
		return null;
	}
	if (!isRelayApiBaseSubscription(canonical)) {
		await markDunningFailure(
			db,
			row,
			`Stripe subscription ${canonical.id} is not a server-tagged base subscription`,
			{ terminal: true, deactivationFailed: true },
		);
		return null;
	}
	const decision = canonicalDunningDecision(canonical.status);
	if (decision === "recovered") {
		// Re-read and project under the organization fence before recording a
		// terminal recovery decision. Stripe state can change between reads.
		return "recovered";
	}
	if (decision === "already_inactive") {
		return (await markDeactivationSucceeded(db, row, {
			...subscriptionEvidence(canonical),
			action: "already_inactive",
		}))
			? "deactivated"
			: null;
	}
	if (decision === "manual_review") {
		await markDunningFailure(
			db,
			row,
			`Canonical Stripe subscription is ${canonical.status}; deactivation requires manual review`,
			{ terminal: true, deactivationFailed: true },
		);
		return null;
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
	if (staged.length === 0) return null;

	try {
		const canceled = await stripe.subscriptions.cancel(
			stripeSubscriptionId,
			{},
			{ idempotencyKey: row.deactivationOperationId ?? undefined },
		);
		return (await markDeactivationSucceeded(db, row, {
			...subscriptionEvidence(canceled),
			action: "canceled",
		}))
			? "deactivated"
			: null;
	} catch (cancelError) {
		try {
			const reconciled =
				await stripe.subscriptions.retrieve(stripeSubscriptionId);
			if (reconciled.status === "canceled") {
				return (await markDeactivationSucceeded(db, row, {
					...subscriptionEvidence(reconciled),
					action: "canceled",
				}))
					? "deactivated"
					: null;
			}
			await markDunningFailure(db, row, cancelError, {
				deactivationFailed: true,
			});
			return null;
		} catch (reconcileError) {
			if (stripeStatusCode(reconcileError) === 404) {
				return (await markDeactivationSucceeded(db, row, {
					status: "not_found",
					action: "already_inactive",
				}))
					? "deactivated"
					: null;
			}
			await parkAmbiguousDeactivation(
				db,
				row,
				new AggregateError(
					[cancelError, reconcileError],
					"Stripe cancellation outcome could not be reconciled",
				),
				requestedAt,
			);
			return null;
		}
	}
}

/**
 * Heal a missed recovery webhook under the same per-organization fence used by
 * Stripe event projection. The provider is re-read while holding the fence;
 * the transaction then refuses to overwrite a newer subscription transition.
 */
async function projectRecoveredSubscription(
	db: ReturnType<typeof createDb>,
	row: DunningRow,
	stripe: Stripe,
	stripeSubscriptionId: string,
	fence: StripeOrganizationFence,
): Promise<
	| {
			kind: "healed";
			evidence: ReturnType<typeof subscriptionEvidence>;
	  }
	| {
			kind: "target_superseded";
			evidence: ReturnType<typeof subscriptionEvidence>;
	  }
	| { kind: "state_changed"; evidence: DeactivationEvidence }
> {
	await assertStripeOrganizationFence(db, fence);
	const recoveryAt = new Date();
	let canonical: Stripe.Subscription;
	try {
		canonical = await stripe.subscriptions.retrieve(stripeSubscriptionId);
	} catch (error) {
		if (stripeStatusCode(error) === 404) {
			return {
				kind: "state_changed",
				evidence: {
					status: "not_found",
					action: "already_inactive",
				},
			};
		}
		throw error;
	}
	const projection = recoveredSubscriptionProjection(canonical, recoveryAt);
	if (!projection || canonical.id !== stripeSubscriptionId) {
		return {
			kind: "state_changed",
			evidence: {
				...subscriptionEvidence(canonical),
				action: "skipped_superseded",
			},
		};
	}

	const period = canonical.items.data[0];
	if (!period) {
		throw new Error("Recovered Stripe subscription has no billing-period item");
	}
	const periodId = await recoverStripeBillingAuthority(db, {
		organizationId: row.organizationId,
		expectedStripeSubscriptionId: stripeSubscriptionId,
		providerCycleAnchor: new Date(period.current_period_start * 1000),
		providerPeriodEnd: new Date(period.current_period_end * 1000),
		effectiveAt: recoveryAt,
		terms: recoveredStripeBillingTerms(canonical),
		fence,
		subscriptionProjection: projection,
		outbox: {
			id: `dunning:${row.id}:recovery:auth`,
			payload: { eventId: row.id },
		},
	});
	if (!periodId) {
		return {
			kind: "target_superseded",
			evidence: subscriptionEvidence(canonical),
		};
	}
	return {
		kind: "healed",
		evidence: subscriptionEvidence(canonical),
	};
}

async function dunningTargetIsCurrent(
	db: ReturnType<typeof createDb>,
	organizationId: string,
	stripeSubscriptionId: string,
	fence: StripeOrganizationFence,
): Promise<boolean> {
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, fence);
		const [local] = await tx
			.select({
				stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			})
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId))
			.for("update")
			.limit(1);
		return local?.stripeSubscriptionId === stripeSubscriptionId;
	});
}

export async function deliverDunningEvent(
	db: ReturnType<typeof createDb>,
	env: Env,
	row: DunningRow,
	context: {
		billingEmail: string | null;
		orgName: string;
		invoiceUrl: string | null;
		stripeInvoiceId: string | null;
	},
): Promise<void> {
	try {
		if (row.event === "deactivated_14d") {
			if (!context.stripeInvoiceId) {
				await markDunningFailure(
					db,
					row,
					"Stripe invoice ID is missing; deactivation target requires manual review",
					{ terminal: true, deactivationFailed: true },
				);
				return;
			}
			const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
			const organizationFence = await claimStripeOrganizationFence(
				db,
				row.organizationId,
				`dunning:${row.id}:deactivation`,
			);
			if (!organizationFence) {
				throw new Error(
					`Stripe organization aggregate is busy for dunning event ${row.id}`,
				);
			}
			try {
				let stripeSubscriptionId: string | null = null;
				try {
					const failedInvoice = await stripe.invoices.retrieve(
						context.stripeInvoiceId,
					);
					stripeSubscriptionId = invoiceSubscriptionId(failedInvoice);
				} catch (error) {
					await markDunningFailure(db, row, error, {
						terminal: stripeStatusCode(error) === 404,
						deactivationFailed: true,
					});
					return;
				}
				if (!stripeSubscriptionId) {
					await markDunningFailure(
						db,
						row,
						`Stripe invoice ${context.stripeInvoiceId} has no subscription target; deactivation requires manual review`,
						{ terminal: true, deactivationFailed: true },
					);
					return;
				}
				if (
					!(await dunningTargetIsCurrent(
						db,
						row.organizationId,
						stripeSubscriptionId,
						organizationFence,
					))
				) {
					await markDeactivationSucceeded(db, row, {
						id: stripeSubscriptionId,
						status: "superseded",
						action: "skipped_superseded",
					});
					await markDunningSent(db, row);
					return;
				}
				const outcome = await ensureSubscriptionDeactivated(
					db,
					row,
					stripe,
					stripeSubscriptionId,
				);
				if (!outcome) return;
				if (outcome === "recovered") {
					const recovery = await projectRecoveredSubscription(
						db,
						row,
						stripe,
						stripeSubscriptionId,
						organizationFence,
					);
					if (recovery.kind === "state_changed") {
						await markDunningFailure(
							db,
							row,
							`Canonical Stripe state changed during recovery projection: ${JSON.stringify(recovery.evidence)}`,
							{ deactivationFailed: true },
						);
						return;
					}
					const recoveryRecorded = await markDeactivationSucceeded(
						db,
						row,
						recovery.kind === "healed"
							? { ...recovery.evidence, action: "skipped_recovered" }
							: { ...recovery.evidence, action: "skipped_superseded" },
					);
					if (!recoveryRecorded) return;
					await markDunningSent(db, row);
					return;
				}
			} finally {
				await releaseStripeOrganizationFence(db, organizationFence);
			}
		}

		if (!context.billingEmail) {
			await markDunningFailure(db, row, "Organization owner email is missing");
			return;
		}
		if (row.event === "deactivated_14d") {
			await sendPlanDeactivatedEmail(env, {
				organizationId: row.organizationId,
				to: context.billingEmail,
				orgName: context.orgName,
				idempotencyKey: row.deliveryIdempotencyKey,
			});
		} else {
			await sendPaymentFailedReminder(env, {
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
	for (;;) {
		const due = await db
			.select({
				id: dunningEvents.id,
				orgId: dunningEvents.organizationId,
				invoiceId: dunningEvents.invoiceId,
				stripeInvoiceId: sql<string | null>`COALESCE(
					${dunningEvents.stripeInvoiceId},
					${invoices.stripeInvoiceId}
				)`,
				billingEmailInvoiceUrl: invoices.stripeHostedUrl,
				orgName: organization.name,
			})
			.from(dunningEvents)
			.innerJoin(
				organizationSubscriptions,
				eq(
					organizationSubscriptions.organizationId,
					dunningEvents.organizationId,
				),
			)
			.innerJoin(
				organization,
				eq(organization.id, dunningEvents.organizationId),
			)
			.leftJoin(invoices, eq(invoices.id, dunningEvents.invoiceId))
			.where(
				and(
					or(
						eq(organizationSubscriptions.status, "past_due"),
						eq(dunningEvents.event, "deactivated_14d"),
					),
					lte(dunningEvents.dueAt, now),
					or(
						and(
							inArray(dunningEvents.status, ["pending", "failed"]),
							lte(dunningEvents.nextAttemptAt, now),
						),
						and(
							eq(dunningEvents.status, "processing"),
							lte(dunningEvents.leaseExpiresAt, now),
						),
					),
				),
			)
			.orderBy(
				dunningEvents.dueAt,
				dunningEvents.nextAttemptAt,
				dunningEvents.organizationId,
				dunningEvents.id,
			)
			.limit(100);

		let claimedCount = 0;
		for (const candidate of due) {
			try {
				const claimed = await claimDunningEvent(db, candidate.id, now);
				if (!claimed) continue;
				claimedCount++;
				const billingEmail = await getOrgOwnerEmail(db, candidate.orgId);
				await deliverDunningEvent(db, env, claimed, {
					billingEmail,
					orgName: candidate.orgName || "your organization",
					invoiceUrl: candidate.billingEmailInvoiceUrl,
					stripeInvoiceId: candidate.stripeInvoiceId,
				});
			} catch (error) {
				console.error(`Dunning failed for org ${candidate.orgId}:`, error);
			}
		}
		if (due.length < 100 || claimedCount === 0) break;
	}
}

async function getOrgOwnerEmail(
	db: ReturnType<typeof createDb>,
	orgId: string,
): Promise<string | null> {
	const members = await db
		.select({ email: user.email, role: member.role })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(eq(member.organizationId, orgId));
	return selectDunningBillingEmail(members);
}

export function selectDunningBillingEmail(
	members: readonly { email: string; role: string }[],
): string | null {
	return (
		members.find((membership) => hasOrganizationRole(membership.role, "owner"))
			?.email ?? null
	);
}
