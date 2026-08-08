import { getBillingPolicy } from "@relayapi/config";
import {
	billingOutbox,
	billingPeriods,
	createDb,
	type Database,
	generateId,
	organizationSubscriptions,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { Env } from "../types";
import {
	assertStripeOrganizationFence,
	type StripeOrganizationFence,
} from "./stripe-organization-lease";
import { lockOrganizationSubscription } from "./subscription-authority";
import {
	createUsageReservationCarryovers,
	effectiveCarryoverAllowance,
	getUsageCarryoverContribution,
} from "./usage-carryover";

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type HostedSubscriptionBoundary = Pick<
	typeof organizationSubscriptions.$inferSelect,
	| "source"
	| "status"
	| "stripeSubscriptionId"
	| "trialEndsAt"
	| "delinquentAt"
	| "graceEndsAt"
	| "currentPeriodStart"
	| "currentPeriodEnd"
	| "updatedAt"
>;

/** Exact instant at which hosted paid mutation authority becomes Free. */
export function hostedFreeTransitionAt(
	subscription: HostedSubscriptionBoundary,
	now = new Date(),
): Date | null {
	if (subscription.source !== "stripe") return null;
	const policy = getBillingPolicy(subscription, now);
	if (policy.entitlement === "pro") return null;
	const candidate =
		subscription.status === "past_due"
			? subscription.graceEndsAt
			: subscription.status === "trialing"
				? subscription.trialEndsAt
				: subscription.status === "cancelled"
					? subscription.updatedAt
					: null;
	return candidate && candidate <= now ? candidate : null;
}

type CommonBillingPeriodTerms = {
	billable: boolean;
	quotaMode: "hard" | "metered" | "unlimited";
	cycleAllowance: number | null;
	pricePerThousandUnitsCents: number | null;
	basePriceCents: number;
	currency: "usd";
};

export type BillingPeriodTerms = CommonBillingPeriodTerms &
	(
		| {
				source: "stripe";
				stripeCustomerId: string;
				stripeSubscriptionId: string;
				stripeProductId: string;
				stripePriceId: string;
				stripePriceRole: "base";
				rateCardVersion: string;
				taxBehavior: "inclusive" | "exclusive" | "unspecified";
				taxCode: string | null;
				discountable: boolean;
		  }
		| {
				source: "complimentary";
		  }
	);

function agreementValues(terms: BillingPeriodTerms) {
	return terms.source === "stripe"
		? {
				stripeCustomerId: terms.stripeCustomerId,
				stripeSubscriptionId: terms.stripeSubscriptionId,
				stripeProductId: terms.stripeProductId,
				stripePriceId: terms.stripePriceId,
				stripePriceRole: terms.stripePriceRole,
				rateCardVersion: terms.rateCardVersion,
				taxBehavior: terms.taxBehavior,
				taxCode: terms.taxCode,
				discountable: terms.discountable,
			}
		: {
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				stripeProductId: null,
				stripePriceId: null,
				stripePriceRole: null,
				rateCardVersion: null,
				taxBehavior: null,
				taxCode: null,
				discountable: null,
			};
}

function agreementMatches(
	period: typeof billingPeriods.$inferSelect,
	terms: BillingPeriodTerms,
): boolean {
	const agreement = agreementValues(terms);
	return (
		period.stripeCustomerId === agreement.stripeCustomerId &&
		period.stripeSubscriptionId === agreement.stripeSubscriptionId &&
		period.stripeProductId === agreement.stripeProductId &&
		period.stripePriceId === agreement.stripePriceId &&
		period.stripePriceRole === agreement.stripePriceRole &&
		period.rateCardVersion === agreement.rateCardVersion &&
		period.taxBehavior === agreement.taxBehavior &&
		period.taxCode === agreement.taxCode &&
		period.discountable === agreement.discountable
	);
}

export function remainingCycleAllowance(
	quotaMode: BillingPeriodTerms["quotaMode"],
	cycleAllowance: number | null,
	cycleCommitted: number,
): number | null {
	if (quotaMode === "unlimited") return null;
	if (
		cycleAllowance === null ||
		!Number.isSafeInteger(cycleAllowance) ||
		cycleAllowance < 0 ||
		!Number.isSafeInteger(cycleCommitted) ||
		cycleCommitted < 0
	) {
		throw new Error("Bounded billing allowances must be nonnegative integers");
	}
	return Math.max(0, cycleAllowance - cycleCommitted);
}

/**
 * A delayed provider event cannot retroactively move usage that was authorized
 * by the old bucket. Keep the old half of a split large enough to contain every
 * reservation already pinned to it.
 */
export function safeBillingTransitionInstant(
	requestedAt: Date,
	latestReservationAt: Date | null,
	periodStart: Date,
	periodEnd: Date,
): Date {
	const transitionAt =
		latestReservationAt && latestReservationAt > requestedAt
			? latestReservationAt
			: requestedAt;
	if (transitionAt <= periodStart || transitionAt >= periodEnd) {
		throw new Error(
			"Billing-period transition cannot preserve the existing reservation window",
		);
	}
	return transitionAt;
}

/**
 * Canonical period/bucket boundary transition. Callers must hold the bucket row
 * lock first and the period row lock second. Reserve/finalize use the same
 * bucket-first order, so the latest-reservation read is stable until commit and
 * no new reservation can enter the shortened bucket concurrently.
 *
 * We retain every reservation in its original bucket. Reading all reservation
 * states is intentionally stronger than the required live-reservation rule:
 * `old period_end >= max(reserved_at)` remains true for both in-flight and
 * already-finalized financial evidence.
 */
async function transitionOpenBillingPeriodBoundary(
	tx: BillingTransaction,
	input: {
		periodId: string;
		bucketId: string;
		periodStart: Date;
		periodEnd: Date;
		requestedAt: Date;
		close: boolean;
	},
): Promise<Date> {
	const [latestReservation] = await tx
		.select({ reservedAt: usageReservations.reservedAt })
		.from(usageReservations)
		.where(eq(usageReservations.bucketId, input.bucketId))
		.orderBy(desc(usageReservations.reservedAt))
		.limit(1);
	const transitionAt = safeBillingTransitionInstant(
		input.requestedAt,
		latestReservation?.reservedAt ?? null,
		input.periodStart,
		input.periodEnd,
	);

	await tx.execute(
		sql`SET CONSTRAINTS usage_buckets_billing_period_window_fk DEFERRED`,
	);
	await tx
		.update(billingPeriods)
		.set(
			input.close
				? {
						periodEnd: transitionAt,
						state: "closed",
						closedAt: transitionAt,
					}
				: { periodEnd: transitionAt },
		)
		.where(
			and(
				eq(billingPeriods.id, input.periodId),
				eq(billingPeriods.state, "open"),
			),
		);
	await tx
		.update(usageBuckets)
		.set({ periodEnd: transitionAt })
		.where(
			and(
				eq(usageBuckets.id, input.bucketId),
				eq(usageBuckets.billingPeriodId, input.periodId),
			),
		);

	return transitionAt;
}

export async function setComplimentaryPlan(
	db: Database,
	input: {
		organizationId: string;
		active: boolean;
		effectiveAt?: Date;
		cycleAllowance: number;
	},
): Promise<string> {
	const effectiveAt = input.effectiveAt ?? new Date();
	const successorEnd = nextComplimentaryCycleBoundary(effectiveAt);
	return db.transaction(async (tx) => {
		const subscription = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"update",
		);
		if (
			subscription?.source === "stripe" &&
			subscription.status !== "cancelled"
		) {
			throw new Error(
				"An active Stripe subscription cannot be replaced by an administrative grant",
			);
		}

		const [candidate] = await tx
			.select({
				periodId: billingPeriods.id,
				bucketId: usageBuckets.id,
				providerCycleAnchor: billingPeriods.providerCycleAnchor,
			})
			.from(usageBuckets)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					sql`${billingPeriods.periodStart} <= ${effectiveAt}`,
					gt(billingPeriods.periodEnd, effectiveAt),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.limit(1);

		if (candidate) {
			const cycleBuckets = await tx
				.select({
					id: usageBuckets.id,
					periodId: usageBuckets.billingPeriodId,
					committedUnits: usageBuckets.committedUnits,
					reservedUnits: usageBuckets.reservedUnits,
				})
				.from(usageBuckets)
				.innerJoin(
					billingPeriods,
					and(
						eq(billingPeriods.id, usageBuckets.billingPeriodId),
						eq(billingPeriods.organizationId, usageBuckets.organizationId),
					),
				)
				.where(
					and(
						eq(billingPeriods.organizationId, input.organizationId),
						eq(
							billingPeriods.providerCycleAnchor,
							candidate.providerCycleAnchor,
						),
						sql`${billingPeriods.state} <> 'void'`,
						eq(usageBuckets.metric, "successful_mutation"),
					),
				)
				.orderBy(asc(usageBuckets.id))
				.for("update", { of: usageBuckets });
			const [current] = await tx
				.select()
				.from(billingPeriods)
				.where(
					and(
						eq(billingPeriods.id, candidate.periodId),
						eq(billingPeriods.state, "open"),
					),
				)
				.for("update")
				.limit(1);
			if (!current) {
				throw new Error("Billing authority changed during the grant");
			}
			const currentBucket = cycleBuckets.find(
				(bucket) =>
					bucket.id === candidate.bucketId && bucket.periodId === current.id,
			);
			if (!currentBucket) {
				throw new Error("Billing bucket changed during the grant");
			}

			if (input.active) {
				if (
					current.source === "complimentary" &&
					!current.billable &&
					current.quotaMode === "hard" &&
					current.cycleAllowance === input.cycleAllowance &&
					current.basePriceCents === 0
				) {
				} else {
					const committed = cycleBuckets.reduce(
						(sum, row) => sum + row.committedUnits,
						0,
					);
					const includedUnits = remainingCycleAllowance(
						"hard",
						input.cycleAllowance,
						committed,
					);
					const transitionAt = await transitionOpenBillingPeriodBoundary(tx, {
						periodId: current.id,
						bucketId: currentBucket.id,
						periodStart: current.periodStart,
						periodEnd: current.periodEnd,
						requestedAt: effectiveAt,
						close: false,
					});
					const successorPeriodId = generateId("bp_");
					await tx.insert(billingPeriods).values({
						id: successorPeriodId,
						organizationId: input.organizationId,
						source: "complimentary",
						billable: false,
						quotaMode: "hard",
						providerCycleAnchor: current.providerCycleAnchor,
						periodStart: transitionAt,
						periodEnd: current.periodEnd,
						cycleAllowance: input.cycleAllowance,
						includedUnits,
						pricePerThousandUnitsCents: null,
						basePriceCents: 0,
						currency: "usd",
					});
					const successorBucketId = generateId("ub_");
					await tx.insert(usageBuckets).values({
						id: successorBucketId,
						organizationId: input.organizationId,
						billingPeriodId: successorPeriodId,
						metric: "successful_mutation",
						periodStart: transitionAt,
						periodEnd: current.periodEnd,
						quotaMode: "hard",
						includedUnits,
					});
					await createUsageReservationCarryovers(tx, {
						organizationId: input.organizationId,
						sourceBucketIds: cycleBuckets.map((bucket) => bucket.id),
						successorBucketId,
					});
				}
			} else {
				if (current.source !== "complimentary") {
					throw new Error(
						"Stripe subscription state must be changed through Stripe",
					);
				}
				if (
					effectiveAt > current.periodStart ||
					currentBucket.committedUnits > 0 ||
					currentBucket.reservedUnits > 0
				) {
					await transitionOpenBillingPeriodBoundary(tx, {
						periodId: current.id,
						bucketId: currentBucket.id,
						periodStart: current.periodStart,
						periodEnd: current.periodEnd,
						requestedAt: effectiveAt,
						close: true,
					});
				} else {
					await tx
						.update(billingPeriods)
						.set({ state: "void", voidedAt: effectiveAt })
						.where(eq(billingPeriods.id, current.id));
				}
			}
		} else if (input.active) {
			const periodId = generateId("bp_");
			await tx.insert(billingPeriods).values({
				id: periodId,
				organizationId: input.organizationId,
				source: "complimentary",
				billable: false,
				quotaMode: "hard",
				providerCycleAnchor: effectiveAt,
				periodStart: effectiveAt,
				periodEnd: successorEnd,
				cycleAllowance: input.cycleAllowance,
				includedUnits: input.cycleAllowance,
				pricePerThousandUnitsCents: null,
				basePriceCents: 0,
				currency: "usd",
			});
			await tx.insert(usageBuckets).values({
				id: generateId("ub_"),
				organizationId: input.organizationId,
				billingPeriodId: periodId,
				metric: "successful_mutation",
				periodStart: effectiveAt,
				periodEnd: successorEnd,
				quotaMode: "hard",
				includedUnits: input.cycleAllowance,
			});
		}

		const values = {
			status: input.active ? ("active" as const) : ("cancelled" as const),
			source: "complimentary" as const,
			delinquentAt: null,
			graceEndsAt: null,
			trialEndsAt: null,
			// Customer identity is historical financial attribution, not a Pro
			// entitlement. Preserve it so late invoices/credits from a prior Stripe
			// agreement still resolve after an operator grants complimentary access.
			stripeSubscriptionId: null,
			stripeMeteredItemId: null,
			cancelAtPeriodEnd: false,
			updatedAt: effectiveAt,
		};
		await tx
			.update(organizationSubscriptions)
			.set(values)
			.where(eq(organizationSubscriptions.id, subscription.id));
		return subscription.id;
	});
}

export async function openBillingPeriod(
	db: Database,
	input: {
		organizationId: string;
		providerCycleAnchor: Date;
		periodStart: Date;
		periodEnd: Date;
		terms: BillingPeriodTerms;
		fence?: StripeOrganizationFence | null;
	},
): Promise<string> {
	if (
		input.periodStart >= input.periodEnd ||
		input.providerCycleAnchor > input.periodStart
	) {
		throw new Error("Billing-period authority has an invalid window");
	}
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const candidateId = generateId("bp_");
		await tx
			.insert(billingPeriods)
			.values({
				id: candidateId,
				organizationId: input.organizationId,
				source: input.terms.source,
				billable: input.terms.billable,
				quotaMode: input.terms.quotaMode,
				providerCycleAnchor: input.providerCycleAnchor,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				cycleAllowance: input.terms.cycleAllowance,
				includedUnits: input.terms.cycleAllowance,
				pricePerThousandUnitsCents: input.terms.pricePerThousandUnitsCents,
				basePriceCents: input.terms.basePriceCents,
				currency: input.terms.currency,
				...agreementValues(input.terms),
			})
			.onConflictDoNothing({
				target: [billingPeriods.organizationId, billingPeriods.periodStart],
				where: sql`${billingPeriods.state} <> 'void'`,
			});
		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.periodStart, input.periodStart),
					sql`${billingPeriods.state} <> 'void'`,
				),
			)
			.limit(1);
		if (
			!period ||
			period.periodEnd.getTime() !== input.periodEnd.getTime() ||
			period.providerCycleAnchor.getTime() !==
				input.providerCycleAnchor.getTime() ||
			period.source !== input.terms.source ||
			period.billable !== input.terms.billable ||
			period.quotaMode !== input.terms.quotaMode ||
			period.cycleAllowance !== input.terms.cycleAllowance ||
			period.includedUnits !== input.terms.cycleAllowance ||
			period.pricePerThousandUnitsCents !==
				input.terms.pricePerThousandUnitsCents ||
			period.basePriceCents !== input.terms.basePriceCents ||
			period.currency !== input.terms.currency ||
			!agreementMatches(period, input.terms)
		) {
			throw new Error(
				"Existing billing period does not match the requested authority",
			);
		}
		await tx
			.insert(usageBuckets)
			.values({
				id: generateId("ub_"),
				organizationId: input.organizationId,
				billingPeriodId: period.id,
				metric: "successful_mutation",
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				quotaMode: input.terms.quotaMode,
				includedUnits: input.terms.cycleAllowance,
			})
			.onConflictDoNothing({
				target: [
					usageBuckets.organizationId,
					usageBuckets.metric,
					usageBuckets.periodStart,
				],
			});
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.metric, "successful_mutation"),
					eq(usageBuckets.periodStart, input.periodStart),
				),
			)
			.for("update")
			.limit(1);
		if (
			!bucket ||
			bucket.billingPeriodId !== period.id ||
			bucket.periodEnd.getTime() !== input.periodEnd.getTime() ||
			bucket.quotaMode !== input.terms.quotaMode ||
			bucket.includedUnits !== input.terms.cycleAllowance
		) {
			throw new Error(
				"Existing usage bucket does not match the requested billing period",
			);
		}
		await tx
			.select({ id: billingPeriods.id })
			.from(billingPeriods)
			.where(eq(billingPeriods.id, period.id))
			.for("share")
			.limit(1);
		return period.id;
	});
}

/**
 * Split an open period without moving earlier usage or live reservations.
 * The successor receives only the allowance still unused by finalized usage;
 * settlement-aware edges temporarily hold unresolved N and later debit only K.
 */
export async function splitBillingPeriod(
	db: Database,
	input: {
		organizationId: string;
		providerCycleAnchor: Date;
		effectiveAt: Date;
		terms: BillingPeriodTerms;
		fence?: StripeOrganizationFence | null;
	},
): Promise<{ oldPeriodId: string; successorPeriodId: string } | null> {
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const [candidate] = await tx
			.select({
				periodId: billingPeriods.id,
				bucketId: usageBuckets.id,
				providerCycleAnchor: billingPeriods.providerCycleAnchor,
			})
			.from(usageBuckets)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					eq(billingPeriods.providerCycleAnchor, input.providerCycleAnchor),
					lt(billingPeriods.periodStart, input.effectiveAt),
					gt(billingPeriods.periodEnd, input.effectiveAt),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.limit(1);
		if (!candidate) return null;

		// Lock every bucket whose committed counter contributes to the allowance
		// snapshot before locking period rows. Reserve/finalize use the same
		// bucket-first order, so no committed transition can race the split.
		const cycleBuckets = await tx
			.select({
				id: usageBuckets.id,
				periodId: usageBuckets.billingPeriodId,
				committedUnits: usageBuckets.committedUnits,
				reservedUnits: usageBuckets.reservedUnits,
			})
			.from(usageBuckets)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.providerCycleAnchor, input.providerCycleAnchor),
					sql`${billingPeriods.state} <> 'void'`,
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.orderBy(asc(usageBuckets.id))
			.for("update", { of: usageBuckets });

		const [current] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, candidate.periodId),
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					lt(billingPeriods.periodStart, input.effectiveAt),
					gt(billingPeriods.periodEnd, input.effectiveAt),
				),
			)
			.for("update")
			.limit(1);
		if (!current) return null;
		if (
			current.source === input.terms.source &&
			current.billable === input.terms.billable &&
			current.quotaMode === input.terms.quotaMode &&
			current.cycleAllowance === input.terms.cycleAllowance &&
			current.pricePerThousandUnitsCents ===
				input.terms.pricePerThousandUnitsCents &&
			current.basePriceCents === input.terms.basePriceCents &&
			current.currency === input.terms.currency &&
			agreementMatches(current, input.terms)
		) {
			return null;
		}
		const currentBucket = cycleBuckets.find(
			(bucket) =>
				bucket.id === candidate.bucketId && bucket.periodId === current.id,
		);
		if (!currentBucket) {
			throw new Error("Billing bucket changed during the period split");
		}
		const cycleCommitted = cycleBuckets.reduce(
			(total, row) => total + row.committedUnits,
			0,
		);
		const successorAllowance = remainingCycleAllowance(
			input.terms.quotaMode,
			input.terms.cycleAllowance,
			cycleCommitted,
		);

		const transitionAt = await transitionOpenBillingPeriodBoundary(tx, {
			periodId: current.id,
			bucketId: currentBucket.id,
			periodStart: current.periodStart,
			periodEnd: current.periodEnd,
			requestedAt: input.effectiveAt,
			close: false,
		});

		const successorPeriodId = generateId("bp_");
		await tx.insert(billingPeriods).values({
			id: successorPeriodId,
			organizationId: input.organizationId,
			source: input.terms.source,
			billable: input.terms.billable,
			quotaMode: input.terms.quotaMode,
			providerCycleAnchor: current.providerCycleAnchor,
			periodStart: transitionAt,
			periodEnd: current.periodEnd,
			cycleAllowance: input.terms.cycleAllowance,
			includedUnits: successorAllowance,
			pricePerThousandUnitsCents: input.terms.pricePerThousandUnitsCents,
			basePriceCents: input.terms.basePriceCents,
			currency: input.terms.currency,
			...agreementValues(input.terms),
		});
		const successorBucketId = generateId("ub_");
		await tx.insert(usageBuckets).values({
			id: successorBucketId,
			organizationId: input.organizationId,
			billingPeriodId: successorPeriodId,
			metric: "successful_mutation",
			periodStart: transitionAt,
			periodEnd: current.periodEnd,
			quotaMode: input.terms.quotaMode,
			includedUnits: successorAllowance,
		});
		await createUsageReservationCarryovers(tx, {
			organizationId: input.organizationId,
			sourceBucketIds: cycleBuckets.map((bucket) => bucket.id),
			successorBucketId,
		});

		return { oldPeriodId: current.id, successorPeriodId };
	});
}

/**
 * End the last billable window at cancellation without creating a successor.
 * The period remains open until the settlement worker observes its shortened
 * end, preserving final overage billing.
 */
export async function shortenOpenBillingPeriod(
	db: Database,
	input: {
		organizationId: string;
		effectiveAt: Date;
		fence?: StripeOrganizationFence | null;
	},
): Promise<string | null> {
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const [candidate] = await tx
			.select({
				periodId: billingPeriods.id,
				bucketId: usageBuckets.id,
			})
			.from(usageBuckets)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					lt(billingPeriods.periodStart, input.effectiveAt),
					gt(billingPeriods.periodEnd, input.effectiveAt),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.limit(1);
		if (!candidate) return null;
		const [bucket] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.billingPeriodId, candidate.periodId),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.for("update")
			.limit(1);
		if (!bucket) return null;
		const [current] = await tx
			.select({
				id: billingPeriods.id,
				periodStart: billingPeriods.periodStart,
				periodEnd: billingPeriods.periodEnd,
			})
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, candidate.periodId),
					eq(billingPeriods.state, "open"),
					lt(billingPeriods.periodStart, input.effectiveAt),
					gt(billingPeriods.periodEnd, input.effectiveAt),
				),
			)
			.for("update")
			.limit(1);
		if (!current) return null;
		await transitionOpenBillingPeriodBoundary(tx, {
			periodId: current.id,
			bucketId: bucket.id,
			periodStart: current.periodStart,
			periodEnd: current.periodEnd,
			requestedAt: input.effectiveAt,
			close: false,
		});
		return current.id;
	});
}

/**
 * Idempotently close stale hosted paid authority before a Free mutation can be
 * reserved. The subscription, bucket, and period are locked in one transaction
 * so a concurrent recovery/upgrade linearizes entirely before or after this
 * transition. Existing reservations remain on the paid side of the boundary.
 */
export async function ensureHostedFreeUsageAuthorityInTransaction(
	tx: BillingTransaction,
	input: {
		organizationId: string;
		now: Date;
	},
	subscription: typeof organizationSubscriptions.$inferSelect,
): Promise<Date | null> {
	const now = input.now;
	const requestedAt = hostedFreeTransitionAt(subscription, now);
	if (!requestedAt) return null;

	const [candidate] = await tx
		.select({
			periodId: billingPeriods.id,
			bucketId: usageBuckets.id,
		})
		.from(usageBuckets)
		.innerJoin(
			billingPeriods,
			and(
				eq(billingPeriods.id, usageBuckets.billingPeriodId),
				eq(billingPeriods.organizationId, usageBuckets.organizationId),
			),
		)
		.where(
			and(
				eq(billingPeriods.organizationId, input.organizationId),
				eq(billingPeriods.source, "stripe"),
				eq(billingPeriods.state, "open"),
				// A stale provider projection can open a *later* Stripe cycle even
				// though the original delinquency grace already expired. Select the
				// authority that covers `now`, not only one that also covered the old
				// grace boundary, so that later-cycle hard/Pro buckets cannot survive
				// (or recur) after entitlement has become Free.
				lte(billingPeriods.periodStart, now),
				gt(billingPeriods.periodEnd, now),
				eq(usageBuckets.metric, "successful_mutation"),
			),
		)
		.orderBy(desc(billingPeriods.periodStart))
		.limit(1);
	if (!candidate) return null;

	const [bucket] = await tx
		.select({
			id: usageBuckets.id,
			committedUnits: usageBuckets.committedUnits,
			reservedUnits: usageBuckets.reservedUnits,
		})
		.from(usageBuckets)
		.where(eq(usageBuckets.id, candidate.bucketId))
		.for("update")
		.limit(1);
	const [period] = await tx
		.select({
			id: billingPeriods.id,
			periodStart: billingPeriods.periodStart,
			periodEnd: billingPeriods.periodEnd,
		})
		.from(billingPeriods)
		.where(
			and(
				eq(billingPeriods.id, candidate.periodId),
				eq(billingPeriods.state, "open"),
				gt(billingPeriods.periodEnd, now),
			),
		)
		.for("update")
		.limit(1);
	if (!bucket || !period) return null;

	let transitionAt: Date;
	if (
		period.periodStart >= requestedAt &&
		bucket.committedUnits === 0 &&
		bucket.reservedUnits === 0
	) {
		await tx.delete(usageBuckets).where(eq(usageBuckets.id, bucket.id));
		await tx
			.update(billingPeriods)
			.set({ state: "void", voidedAt: requestedAt, updatedAt: now })
			.where(
				and(eq(billingPeriods.id, period.id), eq(billingPeriods.state, "open")),
			);
		transitionAt = requestedAt;
	} else {
		const safeRequestedAt =
			requestedAt <= period.periodStart ? now : requestedAt;
		transitionAt = await transitionOpenBillingPeriodBoundary(tx, {
			periodId: period.id,
			bucketId: bucket.id,
			periodStart: period.periodStart,
			periodEnd: period.periodEnd,
			requestedAt: safeRequestedAt,
			close: false,
		});
	}

	await tx
		.insert(billingOutbox)
		.values({
			id: `authority:${period.id}:free`,
			organizationId: input.organizationId,
			kind: "auth_cache.refresh",
			payload: {
				billingPeriodId: period.id,
				transitionAt: transitionAt.toISOString(),
			},
		})
		.onConflictDoNothing();
	return transitionAt;
}

export async function ensureHostedFreeUsageAuthority(
	db: Database,
	input: {
		organizationId: string;
		now?: Date;
		fence?: StripeOrganizationFence | null;
	},
): Promise<Date | null> {
	const now = input.now ?? new Date();
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const subscription = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"update",
		);
		return ensureHostedFreeUsageAuthorityInTransaction(
			tx,
			{ organizationId: input.organizationId, now },
			subscription,
		);
	});
}

/** Bounded minute-level backstop for organizations with no request traffic. */
export async function transitionExpiredHostedBillingAuthorities(
	db: Database,
	now = new Date(),
	batchSize = 100,
): Promise<number> {
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
	let transitioned = 0;
	let cursor: string | null = null;
	for (;;) {
		const candidates = await db
			.selectDistinct({
				organizationId: organizationSubscriptions.organizationId,
			})
			.from(organizationSubscriptions)
			.innerJoin(
				billingPeriods,
				eq(
					billingPeriods.organizationId,
					organizationSubscriptions.organizationId,
				),
			)
			.where(
				and(
					eq(organizationSubscriptions.source, "stripe"),
					eq(billingPeriods.source, "stripe"),
					eq(billingPeriods.state, "open"),
					gt(billingPeriods.periodEnd, now),
					or(
						and(
							eq(organizationSubscriptions.status, "past_due"),
							lte(organizationSubscriptions.graceEndsAt, now),
						),
						and(
							eq(organizationSubscriptions.status, "trialing"),
							lte(organizationSubscriptions.trialEndsAt, now),
						),
						eq(organizationSubscriptions.status, "cancelled"),
					),
					cursor
						? gt(organizationSubscriptions.organizationId, cursor)
						: undefined,
				),
			)
			.orderBy(organizationSubscriptions.organizationId)
			.limit(limit);

		for (const candidate of candidates) {
			try {
				const changed = await ensureHostedFreeUsageAuthority(db, {
					organizationId: candidate.organizationId,
					now,
				});
				if (changed) transitioned += 1;
			} catch (error) {
				// A single malformed or concurrently changing organization must not
				// starve later cursor pages. The next minute-level sweep retries it.
				console.error(
					`Hosted billing-authority transition failed for ${candidate.organizationId}:`,
					error,
				);
			}
		}
		const last = candidates.at(-1);
		if (!last || candidates.length < limit) break;
		cursor = last.organizationId;
	}
	return transitioned;
}

export async function transitionExpiredHostedBillingAuthoritiesForEnv(
	env: Env,
): Promise<number> {
	return transitionExpiredHostedBillingAuthorities(
		createDb(env.HYPERDRIVE.connectionString),
	);
}

export function nextComplimentaryCycleBoundary(start: Date): Date {
	const targetMonth = start.getUTCMonth() + 1;
	const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
	const normalizedMonth = ((targetMonth % 12) + 12) % 12;
	const lastDay = new Date(
		Date.UTC(targetYear, normalizedMonth + 1, 0),
	).getUTCDate();
	const next = new Date(
		Date.UTC(
			targetYear,
			normalizedMonth,
			Math.min(start.getUTCDate(), lastDay),
			start.getUTCHours(),
			start.getUTCMinutes(),
			start.getUTCSeconds(),
			start.getUTCMilliseconds(),
		),
	);
	if (!Number.isFinite(next.getTime()) || next <= start) {
		throw new Error("Complimentary billing cycle did not advance");
	}
	return next;
}

/**
 * Active complimentary grants are indefinite until an administrator cancels
 * them. Keep entitlement and mutation authority aligned by rolling their
 * immutable monthly period/bucket pair forward under the subscription lock.
 */
export async function ensureComplimentaryBillingAuthority(
	db: Database,
	input: { organizationId: string; now?: Date },
): Promise<string | null> {
	const now = input.now ?? new Date();
	if (!Number.isFinite(now.getTime())) {
		throw new Error("Complimentary authority renewal requires a valid time");
	}
	return db.transaction(async (tx) => {
		const subscription = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"update",
		);
		if (
			subscription.source !== "complimentary" ||
			subscription.status !== "active"
		) {
			return null;
		}

		const [latestCandidate] = await tx
			.select({
				periodId: billingPeriods.id,
				bucketId: usageBuckets.id,
			})
			.from(usageBuckets)
			.innerJoin(
				billingPeriods,
				and(
					eq(billingPeriods.id, usageBuckets.billingPeriodId),
					eq(billingPeriods.organizationId, usageBuckets.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.source, "complimentary"),
					sql`${billingPeriods.state} <> 'void'`,
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.orderBy(desc(billingPeriods.periodStart))
			.limit(1);
		if (!latestCandidate) {
			throw new Error(
				"Active complimentary subscription has no billing authority",
			);
		}
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.id, latestCandidate.bucketId),
					eq(usageBuckets.organizationId, input.organizationId),
				),
			)
			.for("update")
			.limit(1);
		const [lockedPeriod] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, latestCandidate.periodId),
					eq(billingPeriods.organizationId, input.organizationId),
				),
			)
			.for("update")
			.limit(1);
		let period: typeof billingPeriods.$inferSelect | undefined = lockedPeriod;
		if (!bucket || !period) {
			throw new Error("Complimentary billing authority changed during renewal");
		}
		if (
			period.billable ||
			period.quotaMode !== "hard" ||
			period.cycleAllowance === null ||
			period.cycleAllowance < 0 ||
			period.includedUnits === null ||
			bucket.quotaMode !== "hard" ||
			bucket.periodStart.getTime() !== period.periodStart.getTime() ||
			bucket.periodEnd.getTime() !== period.periodEnd.getTime()
		) {
			throw new Error("Complimentary billing authority is malformed");
		}
		if (
			period.state === "open" &&
			period.periodStart <= now &&
			period.periodEnd > now
		) {
			return period.id;
		}
		if (period.periodEnd > now) {
			throw new Error("Latest complimentary authority begins in the future");
		}

		const cycleAllowance = period.cycleAllowance;
		let renewedPeriodId: string | null = null;
		for (let cycles = 0; period.periodEnd <= now; cycles += 1) {
			if (cycles >= 240) {
				throw new Error(
					"Complimentary billing authority is over 20 years stale",
				);
			}
			if (period.state === "open") {
				await tx
					.update(billingPeriods)
					.set({
						state: "closed",
						closedAt: period.periodEnd,
						updatedAt: now,
					})
					.where(
						and(
							eq(billingPeriods.id, period.id),
							eq(billingPeriods.state, "open"),
						),
					);
			} else if (period.state !== "closed" && period.state !== "settled") {
				throw new Error(
					`Cannot renew complimentary authority from ${period.state}`,
				);
			}

			const periodStart: Date = period.periodEnd;
			const periodEnd = nextComplimentaryCycleBoundary(periodStart);
			const isCurrent = periodEnd > now;
			const periodId = generateId("bp_");
			const bucketId = generateId("ub_");
			await tx.insert(billingPeriods).values({
				id: periodId,
				organizationId: input.organizationId,
				source: "complimentary",
				billable: false,
				quotaMode: "hard",
				providerCycleAnchor: periodStart,
				periodStart,
				periodEnd,
				cycleAllowance,
				includedUnits: cycleAllowance,
				pricePerThousandUnitsCents: null,
				basePriceCents: 0,
				currency: "usd",
				state: isCurrent ? "open" : "closed",
				closedAt: isCurrent ? null : periodEnd,
				updatedAt: now,
			});
			await tx.insert(usageBuckets).values({
				id: bucketId,
				organizationId: input.organizationId,
				billingPeriodId: periodId,
				metric: "successful_mutation",
				periodStart,
				periodEnd,
				quotaMode: "hard",
				includedUnits: cycleAllowance,
			});
			period = {
				...period,
				id: periodId,
				providerCycleAnchor: periodStart,
				periodStart,
				periodEnd,
				state: isCurrent ? "open" : "closed",
				closedAt: isCurrent ? null : periodEnd,
				createdAt: now,
				updatedAt: now,
			};
			renewedPeriodId = periodId;
		}
		if (!renewedPeriodId) return period.id;
		await tx
			.insert(billingOutbox)
			.values({
				id: `authority:${renewedPeriodId}:complimentary-renewal`,
				organizationId: input.organizationId,
				kind: "auth_cache.refresh",
				payload: {
					billingPeriodId: renewedPeriodId,
					transitionAt: period.periodStart.toISOString(),
				},
			})
			.onConflictDoNothing();
		return renewedPeriodId;
	});
}

/**
 * Claim a hard-bounded, due-only renewal batch. `updated_at` is the durable
 * fairness cursor for active complimentary subscriptions: every attempted row
 * moves to the tail before renewal begins, including malformed rows whose
 * renewal later fails. That prevents one broken low-ID grant from permanently
 * starving the rest of the sweep without relying on isolate-local state.
 */
async function claimDueComplimentaryRenewals(
	db: Database,
	now: Date,
	limit: number,
): Promise<Array<{ organizationId: string }>> {
	return db.transaction(async (tx) => {
		const candidates = await tx
			.select({
				organizationId: organizationSubscriptions.organizationId,
			})
			.from(organizationSubscriptions)
			.leftJoin(
				billingPeriods,
				and(
					eq(
						billingPeriods.organizationId,
						organizationSubscriptions.organizationId,
					),
					eq(billingPeriods.source, "complimentary"),
					sql`${billingPeriods.state} <> 'void'`,
					// The partial unique index on (organization_id, period_start)
					// makes this a single latest non-void predecessor per grant.
					sql`${billingPeriods.periodStart} = (
						SELECT MAX(newer.period_start)
						FROM public.billing_periods AS newer
						WHERE newer.organization_id = ${organizationSubscriptions.organizationId}
							AND newer.source = 'complimentary'
							AND newer.state <> 'void'
					)`,
				),
			)
			.where(
				and(
					eq(organizationSubscriptions.source, "complimentary"),
					eq(organizationSubscriptions.status, "active"),
					// A missing period is malformed but still needs a fair attempt and
					// an operator-visible error instead of disappearing from the sweep.
					or(isNull(billingPeriods.id), lte(billingPeriods.periodEnd, now)),
				),
			)
			.orderBy(
				asc(organizationSubscriptions.updatedAt),
				asc(organizationSubscriptions.organizationId),
			)
			.limit(limit)
			.for("update", {
				of: organizationSubscriptions,
				skipLocked: true,
			});
		if (candidates.length === 0) return [];

		await tx
			.update(organizationSubscriptions)
			.set({
				updatedAt: sql`GREATEST(
					${organizationSubscriptions.updatedAt} + INTERVAL '1 microsecond',
					CURRENT_TIMESTAMP
				)`,
			})
			.where(
				and(
					inArray(
						organizationSubscriptions.organizationId,
						candidates.map((candidate) => candidate.organizationId),
					),
					eq(organizationSubscriptions.source, "complimentary"),
					eq(organizationSubscriptions.status, "active"),
				),
			);
		return candidates;
	});
}

/** Hard-bounded backstop for active grants with no request traffic. */
export async function renewComplimentaryBillingAuthorities(
	db: Database,
	now = new Date(),
	batchSize = 100,
): Promise<number> {
	if (!Number.isFinite(now.getTime())) {
		throw new Error("Complimentary authority renewal requires a valid time");
	}
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
	let renewed = 0;
	const candidates = await claimDueComplimentaryRenewals(db, now, limit);
	for (const candidate of candidates) {
		try {
			const periodId = await ensureComplimentaryBillingAuthority(db, {
				organizationId: candidate.organizationId,
				now,
			});
			if (periodId) renewed += 1;
		} catch (error) {
			// The durable fairness cursor was already advanced in the claim, so a
			// malformed grant cannot monopolize the next bounded sweep.
			console.error(
				`Complimentary billing-authority renewal failed for ${candidate.organizationId}:`,
				error,
			);
		}
	}
	return renewed;
}

async function settleClosedComplimentaryBillingPeriod(
	db: Database,
	input: { organizationId: string; periodId: string; bucketId: string },
	now: Date,
): Promise<boolean> {
	return db.transaction(async (tx) => {
		// Reservation transitions lock the bucket first. Preserve that order so
		// the zero-dollar snapshot cannot race an in-flight finalization.
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.id, input.bucketId),
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.billingPeriodId, input.periodId),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.for("update")
			.limit(1);
		if (!bucket || bucket.reservedUnits > 0) return false;

		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, input.periodId),
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.source, "complimentary"),
					inArray(billingPeriods.state, ["open", "closed"]),
					lte(billingPeriods.periodEnd, now),
				),
			)
			.for("update")
			.limit(1);
		if (!period) return false;
		if (
			period.billable ||
			period.quotaMode !== "hard" ||
			period.includedUnits === null ||
			period.pricePerThousandUnitsCents !== null
		) {
			throw new Error(`Complimentary billing period ${period.id} is malformed`);
		}

		const carryover = await getUsageCarryoverContribution(tx, {
			organizationId: period.organizationId,
			successorBucketId: bucket.id,
		});
		if (carryover.pendingUnits > 0) return false;
		if (period.state === "open") {
			const [closed] = await tx
				.update(billingPeriods)
				.set({
					state: "closed",
					closedAt: period.periodEnd,
					updatedAt: now,
				})
				.where(
					and(
						eq(billingPeriods.id, period.id),
						eq(billingPeriods.state, "open"),
					),
				)
				.returning({ id: billingPeriods.id });
			if (!closed) return false;
		}
		const effectiveIncludedUnits =
			effectiveCarryoverAllowance(
				period.includedUnits,
				carryover.committedUnits,
			) ?? 0;
		const [claimed] = await tx
			.update(billingPeriods)
			.set({
				state: "claimed",
				claimedAt: now,
				committedUnitsSnapshot: bucket.committedUnits,
				effectiveIncludedUnitsSnapshot: effectiveIncludedUnits,
				// Complimentary hard limits never create a receivable.
				overageUnitsSnapshot: 0,
				amountCentsSnapshot: 0,
				updatedAt: now,
			})
			.where(
				and(
					eq(billingPeriods.id, period.id),
					eq(billingPeriods.state, "closed"),
				),
			)
			.returning({ id: billingPeriods.id });
		if (!claimed) return false;
		const [settled] = await tx
			.update(billingPeriods)
			.set({ state: "settled", settledAt: now, updatedAt: now })
			.where(
				and(
					eq(billingPeriods.id, period.id),
					eq(billingPeriods.state, "claimed"),
				),
			)
			.returning({ id: billingPeriods.id });
		if (!settled) {
			throw new Error("Complimentary period settlement fence was lost");
		}
		return true;
	});
}

/**
 * Claim a hard-bounded settlement batch without inverting the usage-ledger
 * lock order. Bucket `updated_at` is the durable attempt cursor: every claimed
 * period moves to the tail before settlement, even if an outstanding
 * reservation, carryover, or malformed snapshot makes the later attempt fail.
 */
async function claimDueComplimentarySettlements(
	db: Database,
	now: Date,
	limit: number,
): Promise<
	Array<{ organizationId: string; periodId: string; bucketId: string }>
> {
	return db.transaction(async (tx) => {
		const discovered = await tx
			.select({
				organizationId: billingPeriods.organizationId,
				periodId: billingPeriods.id,
				bucketId: usageBuckets.id,
			})
			.from(billingPeriods)
			.innerJoin(
				usageBuckets,
				and(
					eq(usageBuckets.billingPeriodId, billingPeriods.id),
					eq(usageBuckets.organizationId, billingPeriods.organizationId),
				),
			)
			.where(
				and(
					eq(billingPeriods.source, "complimentary"),
					inArray(billingPeriods.state, ["open", "closed"]),
					lte(billingPeriods.periodEnd, now),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.orderBy(asc(usageBuckets.updatedAt), asc(usageBuckets.id))
			.limit(limit);

		const claimed: Array<{
			organizationId: string;
			periodId: string;
			bucketId: string;
		}> = [];
		for (const candidate of discovered) {
			// Reservation reserve/finalize operations use this same first lock.
			const [bucket] = await tx
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(
					and(
						eq(usageBuckets.id, candidate.bucketId),
						eq(usageBuckets.organizationId, candidate.organizationId),
						eq(usageBuckets.billingPeriodId, candidate.periodId),
						eq(usageBuckets.metric, "successful_mutation"),
					),
				)
				.for("update", { skipLocked: true })
				.limit(1);
			if (!bucket) continue;

			const [period] = await tx
				.select({ id: billingPeriods.id })
				.from(billingPeriods)
				.where(
					and(
						eq(billingPeriods.id, candidate.periodId),
						eq(billingPeriods.organizationId, candidate.organizationId),
						eq(billingPeriods.source, "complimentary"),
						inArray(billingPeriods.state, ["open", "closed"]),
						lte(billingPeriods.periodEnd, now),
					),
				)
				.for("update", { skipLocked: true })
				.limit(1);
			if (!period) continue;

			await tx
				.update(usageBuckets)
				.set({
					updatedAt: sql`GREATEST(
						${usageBuckets.updatedAt} + INTERVAL '1 microsecond',
						CURRENT_TIMESTAMP
					)`,
				})
				.where(eq(usageBuckets.id, bucket.id));
			claimed.push(candidate);
		}
		return claimed;
	});
}

/** Freeze closed grant periods into terminal, zero-dollar financial snapshots. */
export async function settleClosedComplimentaryBillingPeriods(
	db: Database,
	now = new Date(),
	batchSize = 100,
): Promise<number> {
	if (!Number.isFinite(now.getTime())) {
		throw new Error("Complimentary period settlement requires a valid time");
	}
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
	let settled = 0;
	const candidates = await claimDueComplimentarySettlements(db, now, limit);
	for (const candidate of candidates) {
		try {
			const changed = await settleClosedComplimentaryBillingPeriod(
				db,
				candidate,
				now,
			);
			if (changed) settled += 1;
		} catch (error) {
			console.error(
				`Complimentary billing-period settlement failed for ${candidate.periodId}:`,
				error,
			);
		}
	}
	return settled;
}

export async function renewComplimentaryBillingAuthoritiesForEnv(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const renewed = await renewComplimentaryBillingAuthorities(db);
	await settleClosedComplimentaryBillingPeriods(db);
	return renewed;
}

/**
 * Re-open paid authority after recovery inside the provider's existing cycle.
 * The intervening Free bucket is ended at a reservation-safe instant, and only
 * the paid-cycle allowance not already committed is granted to the successor.
 * Unresolved predecessor N is linked as a temporary hold and resolves to K.
 */
type StripeBillingResumeInput = {
	organizationId: string;
	expectedStripeSubscriptionId: string;
	providerCycleAnchor: Date;
	providerPeriodEnd: Date;
	effectiveAt: Date;
	/** Live entitlement instant; distinct from a delayed provider event time. */
	entitlementAt?: Date;
	terms: Extract<BillingPeriodTerms, { source: "stripe" }>;
};

async function resumeStripeBillingPeriodInTransaction(
	tx: BillingTransaction,
	input: StripeBillingResumeInput,
	subscription: typeof organizationSubscriptions.$inferSelect,
): Promise<string | null> {
	if (
		input.effectiveAt >= input.providerPeriodEnd ||
		input.providerCycleAnchor >= input.providerPeriodEnd
	) {
		return null;
	}
	if (
		subscription.stripeSubscriptionId !== input.expectedStripeSubscriptionId ||
		getBillingPolicy(subscription, input.entitlementAt ?? input.effectiveAt)
			.entitlement !== "pro"
	) {
		return null;
	}

	const openCandidates = await tx
		.select({ id: billingPeriods.id })
		.from(billingPeriods)
		.where(
			and(
				eq(billingPeriods.organizationId, input.organizationId),
				eq(billingPeriods.state, "open"),
				lte(billingPeriods.periodStart, input.effectiveAt),
				gt(billingPeriods.periodEnd, input.effectiveAt),
			),
		)
		.orderBy(asc(billingPeriods.id))
		.limit(2);
	if (openCandidates.length > 1) {
		throw new Error(
			`Multiple open billing authorities cover Stripe recovery for ${input.organizationId}`,
		);
	}
	const existingId = openCandidates[0]?.id;
	if (existingId) {
		// Reservation/finalization lock buckets before periods. Preserve that lock
		// order while proving that an existing authority is exactly the provider
		// cycle and immutable agreement being recovered.
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.billingPeriodId, existingId),
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.for("update")
			.limit(1);
		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, existingId),
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					lte(billingPeriods.periodStart, input.effectiveAt),
					gt(billingPeriods.periodEnd, input.effectiveAt),
				),
			)
			.for("update")
			.limit(1);
		if (!period || !bucket) {
			throw new Error(
				`Existing billing authority changed during Stripe recovery for ${input.organizationId}`,
			);
		}
		if (
			period.source !== "stripe" ||
			period.providerCycleAnchor.getTime() !==
				input.providerCycleAnchor.getTime() ||
			period.periodEnd.getTime() !== input.providerPeriodEnd.getTime() ||
			period.billable !== input.terms.billable ||
			period.quotaMode !== input.terms.quotaMode ||
			period.cycleAllowance !== input.terms.cycleAllowance ||
			period.pricePerThousandUnitsCents !==
				input.terms.pricePerThousandUnitsCents ||
			period.basePriceCents !== input.terms.basePriceCents ||
			period.currency !== input.terms.currency ||
			!agreementMatches(period, input.terms) ||
			bucket.periodStart.getTime() !== period.periodStart.getTime() ||
			bucket.periodEnd.getTime() !== period.periodEnd.getTime() ||
			bucket.quotaMode !== period.quotaMode ||
			bucket.includedUnits !== period.includedUnits
		) {
			throw new Error(
				`Existing open billing authority does not match recovered Stripe terms for ${input.organizationId}`,
			);
		}
		return period.id;
	}

	const [freeBucket] = await tx
		.select()
		.from(usageBuckets)
		.where(
			and(
				eq(usageBuckets.organizationId, input.organizationId),
				eq(usageBuckets.metric, "successful_mutation"),
				isNull(usageBuckets.billingPeriodId),
				lte(usageBuckets.periodStart, input.effectiveAt),
				gt(usageBuckets.periodEnd, input.effectiveAt),
			),
		)
		.for("update")
		.limit(1);

	let successorStart = input.effectiveAt;
	if (freeBucket) {
		const [latestReservation] = await tx
			.select({ reservedAt: usageReservations.reservedAt })
			.from(usageReservations)
			.where(eq(usageReservations.bucketId, freeBucket.id))
			.orderBy(desc(usageReservations.reservedAt))
			.limit(1);
		if (
			freeBucket.periodStart.getTime() === input.effectiveAt.getTime() &&
			freeBucket.committedUnits === 0 &&
			freeBucket.reservedUnits === 0
		) {
			await tx.delete(usageBuckets).where(eq(usageBuckets.id, freeBucket.id));
		} else {
			successorStart = safeBillingTransitionInstant(
				input.effectiveAt,
				latestReservation?.reservedAt ?? null,
				freeBucket.periodStart,
				freeBucket.periodEnd,
			);
			await tx
				.update(usageBuckets)
				.set({ periodEnd: successorStart, updatedAt: input.effectiveAt })
				.where(eq(usageBuckets.id, freeBucket.id));
		}
	}
	if (successorStart >= input.providerPeriodEnd) return null;

	const cycleBuckets = await tx
		.select({
			id: usageBuckets.id,
			committedUnits: usageBuckets.committedUnits,
			reservedUnits: usageBuckets.reservedUnits,
		})
		.from(usageBuckets)
		.innerJoin(
			billingPeriods,
			and(
				eq(billingPeriods.id, usageBuckets.billingPeriodId),
				eq(billingPeriods.organizationId, usageBuckets.organizationId),
			),
		)
		.where(
			and(
				eq(billingPeriods.organizationId, input.organizationId),
				eq(billingPeriods.providerCycleAnchor, input.providerCycleAnchor),
				sql`${billingPeriods.state} <> 'void'`,
				eq(usageBuckets.metric, "successful_mutation"),
			),
		)
		.orderBy(asc(usageBuckets.id))
		.for("update", { of: usageBuckets });
	const cycleConsumed = cycleBuckets.reduce(
		(total, bucket) => total + bucket.committedUnits,
		0,
	);
	const includedUnits = remainingCycleAllowance(
		input.terms.quotaMode,
		input.terms.cycleAllowance,
		cycleConsumed,
	);
	const periodId = generateId("bp_");
	await tx.insert(billingPeriods).values({
		id: periodId,
		organizationId: input.organizationId,
		source: input.terms.source,
		billable: input.terms.billable,
		quotaMode: input.terms.quotaMode,
		providerCycleAnchor: input.providerCycleAnchor,
		periodStart: successorStart,
		periodEnd: input.providerPeriodEnd,
		cycleAllowance: input.terms.cycleAllowance,
		includedUnits,
		pricePerThousandUnitsCents: input.terms.pricePerThousandUnitsCents,
		basePriceCents: input.terms.basePriceCents,
		currency: input.terms.currency,
		...agreementValues(input.terms),
	});
	const successorBucketId = generateId("ub_");
	await tx.insert(usageBuckets).values({
		id: successorBucketId,
		organizationId: input.organizationId,
		billingPeriodId: periodId,
		metric: "successful_mutation",
		periodStart: successorStart,
		periodEnd: input.providerPeriodEnd,
		quotaMode: input.terms.quotaMode,
		includedUnits,
	});
	await createUsageReservationCarryovers(tx, {
		organizationId: input.organizationId,
		sourceBucketIds: cycleBuckets.map((bucket) => bucket.id),
		successorBucketId,
	});
	return periodId;
}

export async function resumeStripeBillingPeriod(
	db: Database,
	input: StripeBillingResumeInput & {
		fence?: StripeOrganizationFence | null;
	},
): Promise<string | null> {
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const subscription = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"update",
		);
		return resumeStripeBillingPeriodInTransaction(tx, input, subscription);
	});
}

export type StripeRecoverySubscriptionProjection = {
	status: "active" | "trialing";
	source: "stripe";
	delinquentAt: null;
	graceEndsAt: null;
	stripeCustomerId: string;
	stripeSubscriptionId: string;
	trialEndsAt: Date | null;
	cancelAtPeriodEnd: boolean;
	currentPeriodStart: Date;
	currentPeriodEnd: Date;
	updatedAt: Date;
};

/**
 * Atomically close any expired paid segment, project provider recovery, end
 * the intervening Free bucket, and create (or reuse) the paid successor.
 */
export async function recoverStripeBillingAuthority(
	db: Database,
	input: StripeBillingResumeInput & {
		fence?: StripeOrganizationFence | null;
		subscriptionProjection: StripeRecoverySubscriptionProjection;
		outbox: { id: string; payload: Record<string, unknown> };
	},
): Promise<string | null> {
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, input.fence ?? null);
		const local = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"update",
		);
		if (
			local.stripeSubscriptionId !== input.expectedStripeSubscriptionId ||
			input.subscriptionProjection.stripeSubscriptionId !==
				input.expectedStripeSubscriptionId
		) {
			return null;
		}

		await ensureHostedFreeUsageAuthorityInTransaction(
			tx,
			{ organizationId: input.organizationId, now: input.effectiveAt },
			local,
		);
		const [projected] = await tx
			.update(organizationSubscriptions)
			.set(input.subscriptionProjection)
			.where(
				and(
					eq(organizationSubscriptions.id, local.id),
					eq(
						organizationSubscriptions.stripeSubscriptionId,
						input.expectedStripeSubscriptionId,
					),
				),
			)
			.returning();
		if (!projected) {
			throw new Error(
				`Recovered subscription projection was superseded for ${input.organizationId}`,
			);
		}
		const periodId = await resumeStripeBillingPeriodInTransaction(
			tx,
			input,
			projected,
		);
		if (!periodId) {
			throw new Error(
				`Recovered subscription has no current paid usage authority for ${input.organizationId}`,
			);
		}
		await tx
			.insert(billingOutbox)
			.values({
				id: input.outbox.id,
				organizationId: input.organizationId,
				kind: "auth_cache.refresh",
				payload: input.outbox.payload,
			})
			.onConflictDoNothing();
		return periodId;
	});
}
