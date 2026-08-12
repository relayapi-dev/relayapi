import { getBillingPolicy, PRICING } from "@relayapi/config";
import {
	billingOutbox,
	createDb,
	type Database,
	organizationSubscriptions,
	stripeOrganizationLeases,
} from "@relayapi/db";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import {
	BASE_PRICE_TAX_BEHAVIOR,
	BASE_PRICE_TAX_CODE,
	BILLING_RATE_CARD_VERSION,
	OVERAGE_DISCOUNTABLE,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env } from "../types";
import {
	type BillingPeriodTerms,
	ensureHostedFreeUsageAuthority,
	resumeStripeBillingPeriod,
	splitBillingPeriod,
} from "./billing-periods";
import { createStripeClient } from "./stripe";
import {
	assertStripeOrganizationFence,
	claimStripeOrganizationFence,
	releaseStripeOrganizationFence,
} from "./stripe-organization-lease";
import {
	isRelayApiBaseSubscription,
	mapStripeSubscriptionStatus,
	resolveCanonicalStripeSubscription,
} from "./stripe-subscriptions";
import { lockOrganizationSubscription } from "./subscription-authority";

type LocalSubscription = typeof organizationSubscriptions.$inferSelect;
type LocalSubscriptionStatus = LocalSubscription["status"];

export type StripeBillingAuthorityRepairResult =
	| {
			state: "ready";
			plan: "pro";
			billingPeriodId: string;
			subscriptionStatus: "active" | "trialing" | "past_due";
	  }
	| {
			state: "ready";
			plan: "free";
			billingPeriodId: null;
			subscriptionStatus: LocalSubscriptionStatus;
	  }
	| {
			state: "pending";
			reason:
				| "fence_busy"
				| "local_subscription_missing"
				| "provider_or_projection_failed"
				| "authority_still_missing";
			error?: unknown;
	  };

function stripeId(
	value: string | { id: string } | null | undefined,
): string | null {
	if (!value) return null;
	return typeof value === "string" ? value : value.id;
}

function subscriptionPeriod(subscription: Stripe.Subscription): {
	start: Date;
	end: Date;
} {
	const item = subscription.items.data[0];
	if (!item) {
		throw new Error(
			`Stripe subscription ${subscription.id} has no billing-period item`,
		);
	}
	const start = new Date(item.current_period_start * 1000);
	const end = new Date(item.current_period_end * 1000);
	if (
		!Number.isFinite(start.getTime()) ||
		!Number.isFinite(end.getTime()) ||
		start >= end
	) {
		throw new Error(
			`Stripe subscription ${subscription.id} has an invalid billing window`,
		);
	}
	return { start, end };
}

function canonicalStripeTerms(
	subscription: Stripe.Subscription,
	status: ReturnType<typeof mapStripeSubscriptionStatus>,
): Extract<BillingPeriodTerms, { source: "stripe" }> {
	if (!isRelayApiBaseSubscription(subscription)) {
		throw new Error(
			`Stripe subscription ${subscription.id} is not a RelayAPI base subscription`,
		);
	}
	const price = subscription.items.data[0]?.price;
	const customerId = stripeId(subscription.customer);
	const productId = price ? stripeId(price.product) : null;
	if (!price || !customerId || !productId) {
		throw new Error(
			`Stripe subscription ${subscription.id} lacks immutable agreement identity`,
		);
	}
	if (price.currency !== "usd") {
		throw new Error(
			`Stripe subscription ${subscription.id} uses unsupported currency ${price.currency}`,
		);
	}
	const billable = status === "active";
	return {
		source: "stripe",
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
		quotaMode: billable ? "metered" : "hard",
		cycleAllowance: PRICING.proCallsIncluded,
		pricePerThousandUnitsCents: billable
			? PRICING.pricePerThousandCallsCents
			: null,
		basePriceCents: price.unit_amount ?? 0,
		currency: "usd",
	};
}

async function enqueueAuthorityRefresh(
	db: Database,
	organizationId: string,
	id: string,
): Promise<void> {
	await db
		.insert(billingOutbox)
		.values({
			id,
			organizationId,
			kind: "auth_cache.refresh",
			payload: { reason: "canonical_billing_authority_repair" },
		})
		.onConflictDoNothing();
}

/**
 * Re-read one organization's canonical base subscription while holding the
 * same per-organization Stripe fence as webhook processing. Provider I/O is
 * outside database transactions; every local projection reasserts the fence.
 */
export async function reconcileStripeBillingAuthority(
	env: Env,
	db: Database,
	input: {
		organizationId: string;
		ownerId?: string;
		now?: Date;
		stripe?: Stripe;
	},
): Promise<StripeBillingAuthorityRepairResult> {
	const now = input.now ?? new Date();
	const ownerId =
		input.ownerId ??
		`billing-authority:${input.organizationId}:${crypto.randomUUID()}`;
	const fence = await claimStripeOrganizationFence(
		db,
		input.organizationId,
		ownerId,
	);
	if (!fence) return { state: "pending", reason: "fence_busy" };

	try {
		const [before] = await db
			.select()
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, input.organizationId))
			.limit(1);
		if (!before) {
			return { state: "pending", reason: "local_subscription_missing" };
		}
		if (before.source !== "stripe" || !before.stripeCustomerId) {
			const policy = getBillingPolicy(before, now);
			return policy.entitlement === "free"
				? {
						state: "ready",
						plan: "free",
						billingPeriodId: null,
						subscriptionStatus: before.status,
					}
				: { state: "pending", reason: "authority_still_missing" };
		}

		const stripe =
			input.stripe ?? (await createStripeClient(env.STRIPE_SECRET_KEY));
		const canonical = await resolveCanonicalStripeSubscription(
			stripe,
			before.stripeCustomerId,
			before.stripeSubscriptionId,
		);

		if (!canonical) {
			await db.transaction(async (tx) => {
				await assertStripeOrganizationFence(tx, fence);
				const local = await lockOrganizationSubscription(
					tx,
					input.organizationId,
					"update",
				);
				if (
					local.source !== "stripe" ||
					local.stripeCustomerId !== before.stripeCustomerId
				) {
					throw new Error(
						"Stripe subscription authority changed during repair",
					);
				}
				await tx
					.update(organizationSubscriptions)
					.set({
						status: "cancelled",
						stripeSubscriptionId: null,
						trialEndsAt: null,
						delinquentAt: null,
						graceEndsAt: null,
						cancelAtPeriodEnd: false,
						updatedAt: now,
					})
					.where(eq(organizationSubscriptions.id, local.id));
			});
			await ensureHostedFreeUsageAuthority(db, {
				organizationId: input.organizationId,
				now,
				fence,
			});
			await enqueueAuthorityRefresh(
				db,
				input.organizationId,
				`authority:${input.organizationId}:${before.stripeSubscriptionId ?? "none"}:free`,
			);
			return {
				state: "ready",
				plan: "free",
				billingPeriodId: null,
				subscriptionStatus: "cancelled",
			};
		}

		if (!isRelayApiBaseSubscription(canonical)) {
			throw new Error(
				`Canonical Stripe subscription ${canonical.id} is not a RelayAPI base subscription`,
			);
		}
		const customerId = stripeId(canonical.customer);
		if (
			customerId !== before.stripeCustomerId ||
			(canonical.metadata.organizationId &&
				canonical.metadata.organizationId !== input.organizationId)
		) {
			throw new Error(
				"Canonical Stripe subscription tenant identity mismatched",
			);
		}
		const status = mapStripeSubscriptionStatus(canonical.status);
		if (status === "cancelled") {
			throw new Error(
				"Canonical subscription resolver returned an inactive row",
			);
		}
		const period = subscriptionPeriod(canonical);
		const trialEndsAt = canonical.trial_end
			? new Date(canonical.trial_end * 1000)
			: null;

		const [projected] = await db.transaction(async (tx) => {
			await assertStripeOrganizationFence(tx, fence);
			const local = await lockOrganizationSubscription(
				tx,
				input.organizationId,
				"update",
			);
			if (local.source !== "stripe" || local.stripeCustomerId !== customerId) {
				throw new Error("Stripe subscription authority changed during repair");
			}
			return tx
				.update(organizationSubscriptions)
				.set({
					status,
					source: "stripe",
					delinquentAt:
						status === "past_due"
							? sql`COALESCE(${organizationSubscriptions.delinquentAt}, ${now})`
							: null,
					graceEndsAt:
						status === "past_due"
							? sql`COALESCE(
								${organizationSubscriptions.graceEndsAt},
								${organizationSubscriptions.delinquentAt} + INTERVAL '14 days',
								${now}::timestamptz + INTERVAL '14 days'
							)`
							: null,
					stripeCustomerId: customerId,
					stripeSubscriptionId: canonical.id,
					trialEndsAt,
					cancelAtPeriodEnd:
						canonical.cancel_at_period_end || Boolean(canonical.cancel_at),
					currentPeriodStart: period.start,
					currentPeriodEnd: period.end,
					updatedAt: now,
				})
				.where(eq(organizationSubscriptions.id, local.id))
				.returning();
		});
		if (!projected) {
			throw new Error("Canonical subscription projection was superseded");
		}

		const policy = getBillingPolicy(projected, now);
		if (policy.entitlement === "free") {
			await ensureHostedFreeUsageAuthority(db, {
				organizationId: input.organizationId,
				now,
				fence,
			});
			await enqueueAuthorityRefresh(
				db,
				input.organizationId,
				`authority:${input.organizationId}:${canonical.id}:free`,
			);
			return {
				state: "ready",
				plan: "free",
				billingPeriodId: null,
				subscriptionStatus: projected.status,
			};
		}

		const terms = canonicalStripeTerms(canonical, status);
		const effectiveAt = now < period.start ? period.start : now;
		if (effectiveAt >= period.end) {
			return { state: "pending", reason: "authority_still_missing" };
		}
		await splitBillingPeriod(db, {
			organizationId: input.organizationId,
			providerCycleAnchor: period.start,
			effectiveAt,
			terms,
			fence,
		});
		const billingPeriodId = await resumeStripeBillingPeriod(db, {
			organizationId: input.organizationId,
			expectedStripeSubscriptionId: canonical.id,
			providerCycleAnchor: period.start,
			providerPeriodEnd: period.end,
			effectiveAt,
			entitlementAt: now,
			terms,
			fence,
		});
		if (!billingPeriodId) {
			return { state: "pending", reason: "authority_still_missing" };
		}
		await enqueueAuthorityRefresh(
			db,
			input.organizationId,
			`authority:${billingPeriodId}:refresh`,
		);
		return {
			state: "ready",
			plan: "pro",
			billingPeriodId,
			subscriptionStatus: status,
		};
	} catch (error) {
		return {
			state: "pending",
			reason: "provider_or_projection_failed",
			error,
		};
	} finally {
		try {
			await releaseStripeOrganizationFence(db, fence);
		} catch (error) {
			console.error("Failed to release Stripe billing-authority fence", {
				organizationId: input.organizationId,
				error: error instanceof Error ? error.message : "unknown error",
			});
		}
	}
}

/**
 * Fair, hard-bounded repair sweep for live Stripe entitlements whose current
 * provider cycle lacks an exact period/bucket authority. Lease `updated_at`
 * acts as a durable attempt cursor, so one provider failure cannot starve
 * higher organization IDs.
 */
export async function reconcileMissingStripeBillingAuthorities(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	now = new Date(),
	batchSize = 25,
): Promise<number> {
	if (isSelfHosted(env)) return 0;
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 50);
	const candidates = await db
		.select({ organizationId: organizationSubscriptions.organizationId })
		.from(organizationSubscriptions)
		.leftJoin(
			stripeOrganizationLeases,
			eq(
				stripeOrganizationLeases.organizationId,
				organizationSubscriptions.organizationId,
			),
		)
		.where(
			and(
				eq(organizationSubscriptions.source, "stripe"),
				or(
					eq(organizationSubscriptions.status, "active"),
					and(
						eq(organizationSubscriptions.status, "trialing"),
						gt(organizationSubscriptions.trialEndsAt, now),
					),
					and(
						eq(organizationSubscriptions.status, "past_due"),
						gt(organizationSubscriptions.graceEndsAt, now),
					),
				),
				sql`NOT EXISTS (
					SELECT 1
					FROM public.billing_periods AS current_period
					JOIN public.usage_buckets AS current_bucket
					  ON current_bucket.billing_period_id = current_period.id
					 AND current_bucket.organization_id = current_period.organization_id
					 AND current_bucket.metric = 'successful_mutation'
					WHERE current_period.organization_id = ${organizationSubscriptions.organizationId}
					  AND current_period.source = 'stripe'
					  AND current_period.state = 'open'
					  AND current_period.stripe_subscription_id = ${organizationSubscriptions.stripeSubscriptionId}
					  AND current_period.provider_cycle_anchor = ${organizationSubscriptions.currentPeriodStart}
					  AND current_period.period_end = ${organizationSubscriptions.currentPeriodEnd}
					  AND current_period.period_start <= ${now}
					  AND current_period.period_end > ${now}
					  AND current_bucket.period_start = current_period.period_start
					  AND current_bucket.period_end = current_period.period_end
					  AND current_bucket.quota_mode = current_period.quota_mode
					  AND current_bucket.included_units IS NOT DISTINCT FROM current_period.included_units
				)`,
			),
		)
		.orderBy(
			asc(
				sql`COALESCE(${stripeOrganizationLeases.updatedAt}, to_timestamp(0))`,
			),
			asc(organizationSubscriptions.organizationId),
		)
		.limit(limit);

	let repaired = 0;
	const sweepInvocationId = crypto.randomUUID();
	for (const candidate of candidates) {
		const result = await reconcileStripeBillingAuthority(env, db, {
			organizationId: candidate.organizationId,
			// A deterministic owner can reacquire its own live lease and fence an
			// overlapping cron invocation. Keep the owner stable only within this
			// repair call, and unique across sweep invocations.
			ownerId: `billing-authority-sweep:${sweepInvocationId}:${candidate.organizationId}`,
			now,
		});
		if (result.state === "ready") repaired += 1;
		else if (result.reason !== "fence_busy") {
			console.error("Stripe billing-authority backstop repair failed", {
				organizationId: candidate.organizationId,
				reason: result.reason,
				error: result.error instanceof Error ? result.error.message : undefined,
			});
		}
	}
	return repaired;
}
