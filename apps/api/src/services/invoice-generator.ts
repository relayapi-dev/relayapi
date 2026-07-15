import { getBillingPolicy, PRICING } from "@relayapi/config";
import {
	apikey,
	apiRequestLogs,
	billingOperations,
	createDb,
	type Database,
	generateId,
	organizationSubscriptions,
	usageBucketSettlements,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	lt,
	notExists,
	sql,
} from "drizzle-orm";
import { mapConcurrently } from "../lib/concurrency";
import type { Env } from "../types";
import { processOverageBillingOperations } from "./billing-operations";

/**
 * Report committed successful-mutation buckets to Stripe for active
 * subscriptions, and downgrade cancelled/expired subscriptions to free. Runs
 * daily because each organization can have a different Stripe period boundary.
 *
 * Overage is added as an invoice item on the customer's upcoming invoice;
 * Stripe rolls it into the single unified invoice with the $5 base charge.
 *
 * A unique usage_bucket_settlements row claims each closed bucket exactly once.
 * The durable billing operation owns the Stripe side effect and the invoice
 * webhook later links that settlement to Stripe's canonical invoice.
 */
export async function generateInvoices(env: Env): Promise<void> {
	const now = new Date();

	const db = createDb(env.HYPERDRIVE.connectionString);
	// Recover durable operations first, including unknown outcomes from a prior
	// invocation, before discovering new closed usage windows.
	await processOverageBillingOperations(env, db);

	// --- 1. Claim every closed, unsettled paid-tier usage bucket ---
	// Process active Stripe-backed subs in batches. For each, bill any usage
	// record whose period has CLOSED (periodEnd <= now) and is not yet billed —
	// this naturally covers both Stripe-anniversary periods and the calendar
	// fallback, and catches a period missed by a skipped/failed prior run.
	let lastId: string | null = null;
	const BATCH_SIZE = 50;

	while (true) {
		const conditions = [
			eq(organizationSubscriptions.status, "active"),
			isNotNull(organizationSubscriptions.stripeSubscriptionId),
			isNotNull(organizationSubscriptions.stripeCustomerId),
		];
		if (lastId) {
			conditions.push(gt(organizationSubscriptions.id, lastId));
		}

		const dueSubs = await db
			.select()
			.from(organizationSubscriptions)
			.where(and(...conditions))
			.orderBy(organizationSubscriptions.id)
			.limit(BATCH_SIZE);

		if (dueSubs.length === 0) break;
		const lastSub = dueSubs[dueSubs.length - 1];
		if (!lastSub) break;
		lastId = lastSub.id;

		for (const sub of dueSubs) {
			try {
				const billing = getBillingPolicy({
					status: sub.status,
					stripeSubscriptionId: sub.stripeSubscriptionId,
					trialEndsAt: sub.trialEndsAt,
					currentPeriodStart: sub.currentPeriodStart,
					currentPeriodEnd: sub.currentPeriodEnd,
				});
				if (!billing.billable || !sub.stripeCustomerId) continue;
				// The settle buffer exceeds the reservation expiry. A bucket is still
				// row-locked and stale reservations are released transactionally before
				// its committed counter is snapshotted.
				const SETTLE_BUFFER_MS = 30 * 60 * 1000;
				const settleCutoff = new Date(now.getTime() - SETTLE_BUFFER_MS);
				const closedBuckets = await db
					.select()
					.from(usageBuckets)
					.where(
						and(
							eq(usageBuckets.organizationId, sub.organizationId),
							eq(usageBuckets.metric, "successful_mutation"),
							lt(usageBuckets.periodEnd, settleCutoff),
							gt(usageBuckets.includedUnits, PRICING.freeCallsIncluded),
							notExists(
								db
									.select({ id: usageBucketSettlements.id })
									.from(usageBucketSettlements)
									.where(eq(usageBucketSettlements.bucketId, usageBuckets.id)),
							),
						),
					)
					.orderBy(usageBuckets.periodStart)
					.limit(24);

				for (const bucket of closedBuckets) {
					await claimUsageBucketSettlement(
						db,
						bucket,
						sub.stripeCustomerId,
						now,
					);
				}
			} catch (err) {
				console.error(
					`Usage reporting failed for org ${sub.organizationId}:`,
					err,
				);
			}
		}

		// If we got fewer than BATCH_SIZE, we've processed all
		if (dueSubs.length < BATCH_SIZE) break;
	}

	// Process newly-created operations immediately; any unknown/failure remains
	// durable for the next daily reconciliation pass.
	await processOverageBillingOperations(env, db);

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

	// --- 3. Retention: prune old api_request_logs ---
	// The usage-tracking middleware writes one row per authenticated /v1/* call
	// (including GETs) and nothing else deletes from this table, so it grows
	// unboundedly — degrading its own indexes and the per-page COUNT in
	// GET /v1/usage/logs. Delete rows older than the retention horizon on the
	// monthly cron. Batch the delete so a large backlog can't blow the
	// statement timeout in a single transaction.
	const LOG_RETENTION_DAYS = 90;
	const retentionCutoff = new Date(
		now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	);
	try {
		// Bounded loop: each pass deletes up to DELETE_BATCH ids matched by a
		// scoped subquery so the index range scan stays cheap.
		const DELETE_BATCH = 5000;
		const MAX_PASSES = 200; // hard cap (≤1M rows/run) to bound cron runtime
		for (let pass = 0; pass < MAX_PASSES; pass++) {
			const deleted = await db
				.delete(apiRequestLogs)
				.where(
					inArray(
						apiRequestLogs.id,
						db
							.select({ id: apiRequestLogs.id })
							.from(apiRequestLogs)
							.where(lt(apiRequestLogs.createdAt, retentionCutoff))
							.limit(DELETE_BATCH),
					),
				)
				.returning({ id: apiRequestLogs.id });
			if (deleted.length < DELETE_BATCH) break;
		}
	} catch (err) {
		console.error("api_request_logs retention prune failed:", err);
	}
}

async function claimUsageBucketSettlement(
	db: Database,
	bucketCandidate: typeof usageBuckets.$inferSelect,
	stripeCustomerId: string,
	now: Date,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.id, bucketCandidate.id),
					eq(usageBuckets.organizationId, bucketCandidate.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!locked) return;

		const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
		await tx.execute(sql`
			WITH released AS (
				UPDATE ${usageReservations}
				   SET state = 'released', finalized_at = ${now}, response_status = NULL
				 WHERE bucket_id = ${locked.id}
				   AND state = 'reserved'
				   AND reserved_at < ${staleBefore}
				 RETURNING units
			)
			UPDATE ${usageBuckets}
			   SET reserved_units = GREATEST(
					0,
					reserved_units - COALESCE((SELECT SUM(units) FROM released), 0)
				),
				   revision = revision + CASE WHEN EXISTS (SELECT 1 FROM released) THEN 1 ELSE 0 END,
				   updated_at = ${now}
			 WHERE id = ${locked.id}
		`);
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(eq(usageBuckets.id, locked.id))
			.limit(1);
		if (!bucket || bucket.reservedUnits > 0) return;

		const overageUnits = Math.max(
			0,
			bucket.committedUnits - bucket.includedUnits,
		);
		const amountCents = Math.ceil(
			(overageUnits * PRICING.pricePerThousandCallsCents) / 1000,
		);
		const settlementId = generateId("ubs_");
		const [settlement] = await tx
			.insert(usageBucketSettlements)
			.values({
				id: settlementId,
				organizationId: bucket.organizationId,
				bucketId: bucket.id,
				settlementKey: `usage-bucket:${bucket.id}`,
				state: amountCents > 0 ? "claimed" : "released",
				committedUnitsSnapshot: bucket.committedUnits,
				amountCents,
				releasedAt: amountCents > 0 ? null : now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning();
		if (!settlement || amountCents === 0) return;

		await tx.insert(billingOperations).values({
			id: `bop_${settlement.id}`,
			organizationId: bucket.organizationId,
			usageBucketSettlementId: settlement.id,
			stripeCustomerId,
			idempotencyKey: `relayapi:overage:${settlement.settlementKey}`,
			amountCents,
			description: `API mutation overage: ${overageUnits.toLocaleString()} mutations beyond ${bucket.includedUnits.toLocaleString()} included`,
		});
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
