import {
	adCreationOperations,
	adMutationOperations,
	apikey,
	billingOperationAttempts,
	billingOperations,
	billingPeriods,
	createDb,
	type Database,
	organizationSubscriptions,
	toolJobs,
	usageBuckets,
	usageReservationCarryovers,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { STRIPE_SUBSCRIPTION_CYCLE_FINALIZATION_GRACE_SECONDS } from "../config/billing";
import { mapConcurrently } from "../lib/concurrency";
import type { Env } from "../types";
import {
	processCatchupInvoiceOperations,
	processOverageBillingOperations,
} from "./billing-operations";
import { createStripeClient } from "./stripe";
import {
	assertStripeOrganizationFence,
	type StripeOrganizationFence,
} from "./stripe-organization-lease";
import {
	effectiveCarryoverAllowance,
	getUsageCarryoverContribution,
} from "./usage-carryover";

const INVOICE_DISCOVERY_BATCH_SIZE = 100;
const INVOICE_DISCOVERY_CURSOR_KEY =
	"internal:billing:invoice-discovery-cursor:v1";

type InvoiceDiscoveryCursor = {
	periodEnd: Date;
	organizationId: string;
	id: string;
};

type StoredInvoiceDiscoveryCursor = {
	period_end: string;
	organization_id: string;
	id: string;
};

export function parseInvoiceDiscoveryCursor(
	value: unknown,
): InvoiceDiscoveryCursor | null {
	if (!value || typeof value !== "object") return null;
	const stored = value as Partial<StoredInvoiceDiscoveryCursor>;
	if (
		typeof stored.period_end !== "string" ||
		typeof stored.organization_id !== "string" ||
		stored.organization_id.length === 0 ||
		typeof stored.id !== "string" ||
		stored.id.length === 0
	) {
		return null;
	}
	const periodEnd = new Date(stored.period_end);
	if (Number.isNaN(periodEnd.getTime())) return null;
	return {
		periodEnd,
		organizationId: stored.organization_id,
		id: stored.id,
	};
}

function storedInvoiceDiscoveryCursor(
	cursor: InvoiceDiscoveryCursor,
): StoredInvoiceDiscoveryCursor {
	return {
		period_end: cursor.periodEnd.toISOString(),
		organization_id: cursor.organizationId,
		id: cursor.id,
	};
}

export function invoiceDiscoveryFallbackOffset(
	now: Date,
	eligibleCount: number,
): number {
	if (!Number.isSafeInteger(eligibleCount) || eligibleCount < 1) {
		throw new Error(
			"Eligible invoice discovery count must be a positive integer",
		);
	}
	const utcDay = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
	return (utcDay * INVOICE_DISCOVERY_BATCH_SIZE) % eligibleCount;
}

function stripeId(value: string | { id: string } | null | undefined) {
	return typeof value === "string" ? value : (value?.id ?? null);
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	return stripeId(invoice.parent?.subscription_details?.subscription);
}

function linePriceId(line: Stripe.InvoiceLineItem): string | null {
	return stripeId(line.pricing?.price_details?.price);
}

function lineSubscriptionId(line: Stripe.InvoiceLineItem): string | null {
	return (
		stripeId(line.subscription) ??
		line.parent?.subscription_item_details?.subscription ??
		null
	);
}

export function invoiceLineMatchesBillingPeriod(
	line: Stripe.InvoiceLineItem,
	period: Pick<
		typeof billingPeriods.$inferSelect,
		"periodEnd" | "stripeSubscriptionId" | "stripePriceId"
	>,
): boolean {
	return (
		line.parent?.type === "subscription_item_details" &&
		line.parent.subscription_item_details?.proration === false &&
		lineSubscriptionId(line) === period.stripeSubscriptionId &&
		linePriceId(line) === period.stripePriceId &&
		// invoice.created at renewal owns the successor cycle. Its base line starts
		// exactly where the just-closed usage period ends.
		line.period.start === Math.floor(period.periodEnd.getTime() / 1000)
	);
}

/**
 * Find one—and only one—draft renewal invoice whose base subscription line
 * owns this immutable billing agreement and exact service window.
 */
export async function findExactDraftInvoiceForBillingPeriod(
	stripe: Stripe,
	period: typeof billingPeriods.$inferSelect,
): Promise<Stripe.Invoice | null> {
	if (
		!period.stripeCustomerId ||
		!period.stripeSubscriptionId ||
		!period.stripePriceId
	) {
		return null;
	}
	const exact: Stripe.Invoice[] = [];
	const draftInvoices = stripe.invoices.list({
		customer: period.stripeCustomerId,
		subscription: period.stripeSubscriptionId,
		status: "draft",
		limit: 100,
	});
	for await (const invoice of draftInvoices) {
		if (
			invoice.status !== "draft" ||
			invoice.billing_reason !== "subscription_cycle" ||
			stripeId(invoice.customer) !== period.stripeCustomerId ||
			invoiceSubscriptionId(invoice) !== period.stripeSubscriptionId
		) {
			continue;
		}
		let lineMatched = false;
		const lines = stripe.invoices.listLineItems(invoice.id, { limit: 100 });
		for await (const line of lines) {
			if (invoiceLineMatchesBillingPeriod(line, period)) {
				lineMatched = true;
				break;
			}
		}
		if (lineMatched) exact.push(invoice);
	}
	if (exact.length > 1) {
		throw new Error(
			`Multiple Stripe draft invoices match billing period ${period.id}`,
		);
	}
	return exact[0] ?? null;
}

function afterInvoiceDiscoveryCursor(cursor: InvoiceDiscoveryCursor) {
	return sql`(${billingPeriods.periodEnd}, ${billingPeriods.organizationId}, ${billingPeriods.id})
		> (${cursor.periodEnd}, ${cursor.organizationId}, ${cursor.id})`;
}

function throughInvoiceDiscoveryCursor(cursor: InvoiceDiscoveryCursor) {
	return sql`(${billingPeriods.periodEnd}, ${billingPeriods.organizationId}, ${billingPeriods.id})
		<= (${cursor.periodEnd}, ${cursor.organizationId}, ${cursor.id})`;
}

function invoiceDiscoveryEligibility(input: {
	settleCutoff: Date;
	staleBefore: Date;
}) {
	return and(
		inArray(billingPeriods.state, ["open", "closed"]),
		eq(billingPeriods.source, "stripe"),
		eq(billingPeriods.billable, true),
		eq(billingPeriods.releaseCount, 0),
		lt(billingPeriods.periodEnd, input.settleCutoff),
		isNotNull(billingPeriods.stripeCustomerId),
		isNotNull(billingPeriods.stripeSubscriptionId),
		isNotNull(billingPeriods.stripePriceId),
		// An old pre-boundary reservation can be released under the bucket lock.
		// Everything else is a durable owner or ambiguous result that must be
		// resolved before the financial snapshot is frozen.
		sql`EXISTS (
					SELECT 1
					  FROM ${usageBuckets} AS invoice_bucket
					 WHERE invoice_bucket.billing_period_id = ${billingPeriods.id}
					   AND invoice_bucket.organization_id = ${billingPeriods.organizationId}
					   AND invoice_bucket.metric = 'successful_mutation'
					   AND NOT EXISTS (
						SELECT 1
						  FROM ${usageReservations} AS unresolved_reservation
						 WHERE unresolved_reservation.bucket_id = invoice_bucket.id
						   AND unresolved_reservation.organization_id = invoice_bucket.organization_id
						   AND unresolved_reservation.state IN ('reserved', 'parked')
						   AND (
							 unresolved_reservation.state = 'parked'
							 OR unresolved_reservation.reserved_at >= ${input.staleBefore}
							 OR unresolved_reservation.request_may_have_been_sent_at IS NOT NULL
							 OR EXISTS (
								SELECT 1 FROM ${toolJobs} AS live_tool_job
								 WHERE live_tool_job.usage_reservation_id = unresolved_reservation.id
								   AND live_tool_job.organization_id = unresolved_reservation.organization_id
								   AND live_tool_job.status IN ('pending', 'processing')
							 )
							 OR EXISTS (
								SELECT 1 FROM ${adCreationOperations} AS ad_create_owner
								 WHERE ad_create_owner.usage_reservation_id = unresolved_reservation.id
								   AND ad_create_owner.organization_id = unresolved_reservation.organization_id
							 )
							 OR EXISTS (
								SELECT 1 FROM ${adMutationOperations} AS ad_mutation_owner
								 WHERE ad_mutation_owner.usage_reservation_id = unresolved_reservation.id
								   AND ad_mutation_owner.organization_id = unresolved_reservation.organization_id
							 )
							 OR EXISTS (
								SELECT 1 FROM ${whatsappPhoneProvisioningOperations} AS phone_provision_owner
								 WHERE phone_provision_owner.usage_reservation_id = unresolved_reservation.id
								   AND phone_provision_owner.organization_id = unresolved_reservation.organization_id
							 )
							 OR EXISTS (
								SELECT 1 FROM ${whatsappPhoneReleaseOperations} AS phone_release_owner
								 WHERE phone_release_owner.usage_reservation_id = unresolved_reservation.id
								   AND phone_release_owner.organization_id = unresolved_reservation.organization_id
							 )
						   )
					   )
					   AND NOT EXISTS (
						SELECT 1
						  FROM ${usageReservationCarryovers} AS pending_carryover
						  JOIN ${usageReservations} AS carryover_source
						    ON carryover_source.id = pending_carryover.source_reservation_id
						   AND carryover_source.organization_id = pending_carryover.organization_id
						 WHERE pending_carryover.successor_bucket_id = invoice_bucket.id
						   AND pending_carryover.organization_id = invoice_bucket.organization_id
						   AND carryover_source.state IN ('reserved', 'parked')
					   )
				)`,
	);
}

/**
 * Select a bounded provider-I/O page. Obvious unresolved ownership is excluded
 * in PostgreSQL so one old durable operation cannot consume the Stripe read
 * budget. claimBillingPeriod repeats every predicate while holding locks.
 */
async function discoverInvoicePeriods(
	db: Database,
	input: {
		settleCutoff: Date;
		staleBefore: Date;
		after?: InvoiceDiscoveryCursor | null;
		through?: InvoiceDiscoveryCursor | null;
		offset?: number;
		limit: number;
	},
): Promise<(typeof billingPeriods.$inferSelect)[]> {
	return db
		.select()
		.from(billingPeriods)
		.where(
			and(
				invoiceDiscoveryEligibility(input),
				input.after ? afterInvoiceDiscoveryCursor(input.after) : undefined,
				input.through
					? throughInvoiceDiscoveryCursor(input.through)
					: undefined,
			),
		)
		.orderBy(
			asc(billingPeriods.periodEnd),
			asc(billingPeriods.organizationId),
			asc(billingPeriods.id),
		)
		.offset(input.offset ?? 0)
		.limit(input.limit);
}

async function countEligibleInvoicePeriods(
	db: Database,
	input: { settleCutoff: Date; staleBefore: Date },
): Promise<number> {
	const [row] = await db
		.select({ total: sql<string | number>`count(*)::bigint` })
		.from(billingPeriods)
		.where(invoiceDiscoveryEligibility(input));
	const total = Number(row?.total ?? 0);
	if (!Number.isSafeInteger(total) || total < 0) {
		throw new Error(
			"Invoice discovery candidate count is outside the safe range",
		);
	}
	return total;
}

async function loadInvoiceDiscoveryCursor(
	env: Env,
): Promise<InvoiceDiscoveryCursor | null> {
	try {
		return parseInvoiceDiscoveryCursor(
			await env.KV.get<StoredInvoiceDiscoveryCursor>(
				INVOICE_DISCOVERY_CURSOR_KEY,
				"json",
			),
		);
	} catch (error) {
		console.error("[billing] invoice discovery cursor read failed", error);
		return null;
	}
}

async function saveInvoiceDiscoveryCursor(
	env: Env,
	cursor: InvoiceDiscoveryCursor,
): Promise<void> {
	try {
		await env.KV.put(
			INVOICE_DISCOVERY_CURSOR_KEY,
			JSON.stringify(storedInvoiceDiscoveryCursor(cursor)),
		);
	} catch (error) {
		// The cursor controls only efficient work distribution. PostgreSQL claim
		// state remains authoritative, and the next null-cursor run uses the
		// deterministic database rotation below instead of restarting at row one.
		console.error("[billing] invoice discovery cursor write failed", error);
	}
}

/**
 * Report committed successful-mutation buckets to Stripe for active
 * subscriptions, and downgrade cancelled/expired subscriptions to free. Runs
 * daily because each organization can have a different Stripe period boundary.
 *
 * Overage is attached to the exact matching draft renewal invoice. If that
 * draft is unavailable after its finalization grace, a dedicated standalone
 * catch-up invoice is created with pending items explicitly excluded.
 *
 * billing_periods owns the close/claim/settle lifecycle. One unique billing
 * operation per period owns the Stripe side effect, including final periods
 * after cancellation.
 */
export async function generateInvoices(env: Env): Promise<void> {
	const now = new Date();

	const db = createDb(env.HYPERDRIVE.connectionString);
	const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
	await processCatchupInvoiceOperations(env, db, stripe);
	// Recover durable operations first, including unknown outcomes from a prior
	// invocation, before discovering new closed usage windows.
	await processOverageBillingOperations(env, db, stripe);

	// The settle buffer exceeds reservation expiry. Period discovery does not
	// filter on current subscription status, so cancellation cannot lose the
	// final closed period.
	const SETTLE_BUFFER_MS = 30 * 60 * 1000;
	const settleCutoff = new Date(now.getTime() - SETTLE_BUFFER_MS);
	const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
	const initialCursor = await loadInvoiceDiscoveryCursor(env);
	let duePeriods: (typeof billingPeriods.$inferSelect)[];
	if (initialCursor) {
		const afterCursor = await discoverInvoicePeriods(db, {
			settleCutoff,
			staleBefore,
			after: initialCursor,
			limit: INVOICE_DISCOVERY_BATCH_SIZE,
		});
		const remaining = INVOICE_DISCOVERY_BATCH_SIZE - afterCursor.length;
		// Wrap once through the stored tuple. A bounded page therefore rotates over
		// every eligible period instead of restarting at the oldest failure daily.
		const wrappedPeriods =
			remaining > 0
				? await discoverInvoicePeriods(db, {
						settleCutoff,
						staleBefore,
						through: initialCursor,
						limit: remaining,
					})
				: [];
		duePeriods = [...afterCursor, ...wrappedPeriods];
	} else {
		// A missing, malformed, or unavailable KV cursor must not make the first
		// failing provider page a permanent head-of-line blocker. Rotate a bounded
		// PostgreSQL offset by one page per UTC day and wrap at the end. For a stable
		// candidate set this visits every page; concurrent removals only cause safe
		// duplicate or early revisits because claims recheck under row locks.
		const eligibleCount = await countEligibleInvoicePeriods(db, {
			settleCutoff,
			staleBefore,
		});
		if (eligibleCount === 0) {
			duePeriods = [];
		} else {
			const offset = invoiceDiscoveryFallbackOffset(now, eligibleCount);
			const rotatedPeriods = await discoverInvoicePeriods(db, {
				settleCutoff,
				staleBefore,
				offset,
				limit: INVOICE_DISCOVERY_BATCH_SIZE,
			});
			const remaining = INVOICE_DISCOVERY_BATCH_SIZE - rotatedPeriods.length;
			const wrappedPeriods =
				offset > 0 && remaining > 0
					? await discoverInvoicePeriods(db, {
							settleCutoff,
							staleBefore,
							limit: remaining,
						})
					: [];
			duePeriods = [
				...new Map(
					[...rotatedPeriods, ...wrappedPeriods].map((period) => [
						period.id,
						period,
					]),
				).values(),
			];
		}
	}

	for (const candidate of duePeriods) {
		try {
			const targetInvoice = await findExactDraftInvoiceForBillingPeriod(
				stripe,
				candidate,
			);
			if (!targetInvoice) {
				const catchupEligibleAt =
					candidate.periodEnd.getTime() +
					(STRIPE_SUBSCRIPTION_CYCLE_FINALIZATION_GRACE_SECONDS * 1000 +
						30 * 60 * 1000);
				if (now.getTime() >= catchupEligibleAt) {
					await claimBillingPeriod(db, candidate, { kind: "catchup" }, now);
					continue;
				}
				console.warn("[billing] exact cycle invoice unavailable", {
					event: "billing_cycle_invoice_unavailable",
					organizationId: candidate.organizationId,
					billingPeriodId: candidate.id,
				});
				continue;
			}
			await claimBillingPeriod(
				db,
				candidate,
				{ kind: "cycle", stripeInvoiceId: targetInvoice.id },
				now,
			);
		} catch (err) {
			console.error(
				`Usage reporting failed for org ${candidate.organizationId}:`,
				err,
			);
		}
	}
	const lastDiscovered = duePeriods.at(-1);
	if (lastDiscovered) {
		await saveInvoiceDiscoveryCursor(env, {
			periodEnd: lastDiscovered.periodEnd,
			organizationId: lastDiscovered.organizationId,
			id: lastDiscovered.id,
		});
	}

	// Process newly-created operations immediately; any unknown/failure remains
	// durable for the next daily reconciliation pass.
	await processCatchupInvoiceOperations(env, db, stripe);
	await processOverageBillingOperations(env, db, stripe);

	// --- 2. Downgrade cancelled/past_due subscriptions ---
	// Ensure KV entries reflect free plan for inactive subscriptions
	// Process in batches
	let lastInactiveId: string | null = null;
	const INACTIVE_BATCH_SIZE = 100;

	while (true) {
		const conditions = [
			inArray(organizationSubscriptions.status, ["cancelled", "past_due"]),
		];
		if (lastInactiveId) {
			conditions.push(gt(organizationSubscriptions.id, lastInactiveId));
		}

		const inactiveSubs = await db
			.select({
				id: organizationSubscriptions.id,
				organizationId: organizationSubscriptions.organizationId,
			})
			.from(organizationSubscriptions)
			.where(and(...conditions))
			.orderBy(organizationSubscriptions.id)
			.limit(INACTIVE_BATCH_SIZE);

		if (inactiveSubs.length === 0) break;
		const lastInactive = inactiveSubs[inactiveSubs.length - 1];
		if (!lastInactive) break;
		lastInactiveId = lastInactive.id;

		for (const sub of inactiveSubs) {
			try {
				await invalidateOrgKeysInKV(env, db, sub.organizationId);
			} catch (err) {
				console.error(
					`Plan downgrade failed for org ${sub.organizationId}:`,
					err,
				);
			}
		}

		if (inactiveSubs.length < INACTIVE_BATCH_SIZE) break;
	}
}

export async function claimBillingPeriod(
	db: Database,
	periodCandidate: typeof billingPeriods.$inferSelect,
	target: { kind: "cycle"; stripeInvoiceId: string } | { kind: "catchup" },
	now: Date,
	organizationFence?: StripeOrganizationFence | null,
): Promise<boolean> {
	const candidateStripeCustomerId = periodCandidate.stripeCustomerId;
	const candidateStripeSubscriptionId = periodCandidate.stripeSubscriptionId;
	const candidateStripePriceId = periodCandidate.stripePriceId;
	if (
		!candidateStripeCustomerId ||
		!candidateStripeSubscriptionId ||
		!candidateStripePriceId ||
		!periodCandidate.taxBehavior ||
		periodCandidate.discountable === null
	) {
		throw new Error(
			`Billable Stripe period ${periodCandidate.id} is missing its agreement snapshot`,
		);
	}
	if (
		organizationFence &&
		organizationFence.organizationId !== periodCandidate.organizationId
	) {
		throw new Error(
			"Stripe organization fence does not own the billing period",
		);
	}
	return db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, organizationFence ?? null);
		// Discover identifiers without a row lock, then preserve the global usage
		// order used by reservation finalization and plan transitions: bucket first,
		// billing period second. Every discovery predicate is repeated below while
		// the corresponding rows are locked.
		const [bucketCandidate] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.billingPeriodId, periodCandidate.id),
					eq(usageBuckets.organizationId, periodCandidate.organizationId),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.limit(1);
		if (!bucketCandidate) return false;

		const [lockedBucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.id, bucketCandidate.id),
					eq(usageBuckets.organizationId, periodCandidate.organizationId),
					eq(usageBuckets.billingPeriodId, periodCandidate.id),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.for("update")
			.limit(1);
		if (!lockedBucket) return false;

		const [period] = await tx
			.select()
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, periodCandidate.id),
					eq(billingPeriods.organizationId, periodCandidate.organizationId),
					inArray(billingPeriods.state, ["open", "closed"]),
					eq(billingPeriods.source, "stripe"),
					eq(billingPeriods.billable, true),
					eq(billingPeriods.releaseCount, 0),
					eq(billingPeriods.periodEnd, periodCandidate.periodEnd),
					eq(billingPeriods.stripeCustomerId, candidateStripeCustomerId),
					eq(
						billingPeriods.stripeSubscriptionId,
						candidateStripeSubscriptionId,
					),
					eq(billingPeriods.stripePriceId, candidateStripePriceId),
				),
			)
			.for("update")
			.limit(1);
		if (!period) return false;
		if (
			!period.stripeCustomerId ||
			!period.stripeSubscriptionId ||
			!period.stripePriceId ||
			!period.taxBehavior ||
			period.discountable === null
		) {
			throw new Error(
				`Billable Stripe period ${period.id} is missing its agreement snapshot`,
			);
		}

		const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
		await tx
			.update(usageReservations)
			.set({
				state: sql`CASE
							WHEN ${usageReservations.requestMayHaveBeenSentAt} IS NULL
								THEN 'released'
							ELSE 'parked'
						END`,
				disposition: sql`CASE
							WHEN ${usageReservations.requestMayHaveBeenSentAt} IS NULL
								THEN 'pre_boundary'
							ELSE 'unknown'
						END`,
				committedUnits: sql`CASE
							WHEN ${usageReservations.requestMayHaveBeenSentAt} IS NULL
								THEN 0
							ELSE NULL
						END`,
				finalizedAt: sql`CASE
							WHEN ${usageReservations.requestMayHaveBeenSentAt} IS NULL
								THEN ${now}
							ELSE NULL
						END`,
				responseStatus: null,
			})
			.where(
				and(
					eq(usageReservations.bucketId, lockedBucket.id),
					eq(usageReservations.state, "reserved"),
					lt(usageReservations.reservedAt, staleBefore),
					// Period close normally sees only successful-mutation
					// reservations, while tool jobs use tool_invocation buckets.
					// Keep the ownership guard here so malformed/cross-metric
					// data cannot be finalized out from under a live job.
					sql`NOT EXISTS (
							SELECT 1
							  FROM ${toolJobs} AS live_tool_job
							 WHERE live_tool_job.usage_reservation_id = ${usageReservations.id}
							   AND live_tool_job.organization_id = ${usageReservations.organizationId}
							   AND live_tool_job.status IN ('pending', 'processing')
							)`,
					sql`NOT EXISTS (
								SELECT 1 FROM ${adCreationOperations} AS ad_create_owner
								 WHERE ad_create_owner.usage_reservation_id = ${usageReservations.id}
								   AND ad_create_owner.organization_id = ${usageReservations.organizationId}
							)
							AND NOT EXISTS (
								SELECT 1 FROM ${adMutationOperations} AS ad_mutation_owner
								 WHERE ad_mutation_owner.usage_reservation_id = ${usageReservations.id}
								   AND ad_mutation_owner.organization_id = ${usageReservations.organizationId}
							)
							AND NOT EXISTS (
								SELECT 1 FROM ${whatsappPhoneProvisioningOperations} AS phone_provision_owner
								 WHERE phone_provision_owner.usage_reservation_id = ${usageReservations.id}
								   AND phone_provision_owner.organization_id = ${usageReservations.organizationId}
							)
							AND NOT EXISTS (
								SELECT 1 FROM ${whatsappPhoneReleaseOperations} AS phone_release_owner
								 WHERE phone_release_owner.usage_reservation_id = ${usageReservations.id}
								   AND phone_release_owner.organization_id = ${usageReservations.organizationId}
							)`,
				),
			);
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.id, lockedBucket.id),
					eq(usageBuckets.organizationId, period.organizationId),
					eq(usageBuckets.billingPeriodId, period.id),
					eq(usageBuckets.metric, "successful_mutation"),
				),
			)
			.limit(1);
		if (!bucket) return false;
		if (bucket?.reservedUnits && bucket.reservedUnits > 0) return false;
		const carryover = bucket
			? await getUsageCarryoverContribution(tx, {
					organizationId: period.organizationId,
					successorBucketId: bucket.id,
				})
			: { pendingUnits: 0, committedUnits: 0 };
		// Pending predecessor N is a quota hold, never overage. Wait for its
		// durable K/0 disposition before freezing the financial snapshot.
		if (carryover.pendingUnits > 0) return false;

		if (period.state === "open") {
			await tx
				.update(billingPeriods)
				.set({ state: "closed", closedAt: now })
				.where(
					and(
						eq(billingPeriods.id, period.id),
						eq(billingPeriods.state, "open"),
					),
				);
		}
		const committedUnits = bucket?.committedUnits ?? 0;
		const includedUnits =
			effectiveCarryoverAllowance(
				period.includedUnits,
				carryover.committedUnits,
			) ?? 0;
		const overageUnits = Math.max(0, committedUnits - includedUnits);
		const pricePerThousand = period.pricePerThousandUnitsCents ?? 0;
		const amountCents = Math.ceil((overageUnits * pricePerThousand) / 1000);
		if (
			!Number.isSafeInteger(amountCents) ||
			amountCents < 0 ||
			amountCents > 2_147_483_647
		) {
			throw new Error(
				`Billing period ${period.id} produced an invalid int4 charge amount`,
			);
		}
		const [claimed] = await tx
			.update(billingPeriods)
			.set({
				state: "claimed",
				claimedAt: now,
				committedUnitsSnapshot: committedUnits,
				effectiveIncludedUnitsSnapshot: includedUnits,
				overageUnitsSnapshot: overageUnits,
				amountCentsSnapshot: amountCents,
			})
			.where(
				and(
					eq(billingPeriods.id, period.id),
					eq(billingPeriods.state, "closed"),
				),
			)
			.returning({ id: billingPeriods.id });
		if (!claimed) return false;

		if (amountCents === 0) {
			await tx
				.update(billingPeriods)
				.set({ state: "settled", settledAt: now })
				.where(
					and(
						eq(billingPeriods.id, period.id),
						eq(billingPeriods.state, "claimed"),
					),
				);
			return true;
		}

		const operationId = `bop_${period.id}_${target.kind}`;
		const attemptRevision = 1;
		const idempotencyKey = `relayapi:overage:${period.id}:${target.kind}:r${attemptRevision}`;
		const description = `API mutation overage: ${overageUnits.toLocaleString()} mutations beyond ${includedUnits.toLocaleString()} included`;
		const inserted = await tx
			.insert(billingOperations)
			.values({
				id: operationId,
				organizationId: period.organizationId,
				billingPeriodId: period.id,
				kind: target.kind,
				status: target.kind === "catchup" ? "invoice_preparing" : "pending",
				stripeCustomerId: period.stripeCustomerId,
				stripeSubscriptionId: period.stripeSubscriptionId,
				stripeInvoiceId:
					target.kind === "cycle" ? target.stripeInvoiceId : null,
				invoiceIdempotencyKey:
					target.kind === "catchup"
						? `relayapi:overage:${period.id}:catchup-invoice`
						: null,
				idempotencyKey,
				attemptRevision,
				amountCents,
				currency: period.currency,
				description,
			})
			.onConflictDoNothing()
			.returning({ id: billingOperations.id });
		if (inserted.length === 0) {
			throw new Error(
				`Billing period ${period.id} already has a ${target.kind} operation`,
			);
		}
		if (target.kind === "cycle") {
			await tx.insert(billingOperationAttempts).values({
				id: `boa_${period.id}_cycle_r${attemptRevision}`,
				organizationId: period.organizationId,
				billingOperationId: operationId,
				revision: attemptRevision,
				status: "prepared",
				stripeCustomerId: period.stripeCustomerId,
				stripeSubscriptionId: period.stripeSubscriptionId,
				stripeInvoiceId: target.stripeInvoiceId,
				idempotencyKey,
				amountCents,
				currency: period.currency,
				description,
			});
		}
		return true;
	});
}

/**
 * Delete cached API-key authorization in bounded pages. Rehydration reads the
 * authoritative subscription row, and delete-only invalidation cannot resurrect
 * a key concurrently revoked by its owner.
 */
async function invalidateOrgKeysInKV(
	env: Env,
	db: ReturnType<typeof createDb>,
	orgId: string,
): Promise<void> {
	let cursor: string | null = null;
	for (;;) {
		const conditions = [eq(apikey.organizationId, orgId)];
		if (cursor) conditions.push(gt(apikey.key, cursor));
		const keys = await db
			.select({ key: apikey.key })
			.from(apikey)
			.where(and(...conditions))
			.orderBy(asc(apikey.key))
			.limit(100);
		await mapConcurrently(keys, 4, ({ key }) => env.KV.delete(`apikey:${key}`));
		if (keys.length < 100) return;
		cursor = keys.at(-1)?.key ?? null;
		if (!cursor) return;
	}
}
