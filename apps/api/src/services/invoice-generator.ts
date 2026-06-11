import {
	createDb,
	organizationSubscriptions,
	usageRecords,
	apiRequestLogs,
	apikey,
} from "@relayapi/db";
import { and, eq, inArray, isNotNull, isNull, gt, lt } from "drizzle-orm";
import { createStripeClient } from "./stripe";
import { kvTtlForKey } from "../middleware/auth";
import { PRICING } from "../types";
import type { Env, KVKeyData } from "../types";

/**
 * Report metered usage to Stripe for active subscriptions, and downgrade
 * cancelled/expired subscriptions to free. Runs DAILY (index.ts), not only on
 * the 1st: usage_records are keyed on each org's actual Stripe billing period
 * (see resolveBillingPeriod in usage-tracking.ts), which closes on arbitrary
 * calendar days, so the overage item must be added shortly after the period
 * ends — before Stripe finalizes the next invoice.
 *
 * Overage is added as an invoice item on the customer's upcoming invoice;
 * Stripe rolls it into the single unified invoice with the $5 base charge.
 *
 * Idempotency is twofold: each usage_records row is marked `billedAt` after a
 * successful invoice-item create (so no run re-bills it), and a deterministic
 * Stripe idempotency key (org + periodStart) guards against a duplicate item if
 * a run crashes between the Stripe call and the DB mark.
 */
export async function generateInvoices(env: Env): Promise<void> {
	const now = new Date();

	const db = createDb(env.HYPERDRIVE.connectionString);
	const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);

	// --- 1. Report overage to Stripe for every closed, unbilled usage period ---
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
		lastId = dueSubs[dueSubs.length - 1]!.id;

		for (const sub of dueSubs) {
			try {
				// All closed, not-yet-billed usage windows for this org. Usually
				// one; more only if a prior run was skipped. The settle buffer keeps
				// us from billing-and-locking a period while a late write could
				// still target it: after a period roll the cached billing period
				// refreshes within the 10-min KV TTL (or immediately via the
				// subscription.updated webhook), so a period closed > 30 min ago has
				// no remaining writers and billedAt can safely become permanent.
				const SETTLE_BUFFER_MS = 30 * 60 * 1000;
				const settleCutoff = new Date(now.getTime() - SETTLE_BUFFER_MS);
				const closedRecords = await db
					.select()
					.from(usageRecords)
					.where(
						and(
							eq(usageRecords.organizationId, sub.organizationId),
							lt(usageRecords.periodEnd, settleCutoff),
							isNull(usageRecords.billedAt),
							// Only bill paid-tier rows. apiCallsIncluded records the
							// plan allowance at write time, so a leftover calendar-month
							// FREE row (included = freeCallsIncluded) — accrued before
							// this org upgraded — is never converted into a pro overage
							// invoice. Pro rows carry proCallsIncluded (> free).
							gt(usageRecords.apiCallsIncluded, PRICING.freeCallsIncluded),
						),
					)
					.orderBy(usageRecords.periodStart)
					.limit(24);

				for (const usage of closedRecords) {
					const apiCallsCount = usage.apiCallsCount ?? 0;
					// Use the allowance stored on the record (refreshed on every
					// write) rather than a constant, so a mid-period plan change is
					// honored.
					const apiCallsIncluded =
						usage.apiCallsIncluded ?? PRICING.proCallsIncluded;
					const overageCalls = Math.max(0, apiCallsCount - apiCallsIncluded);

					if (overageCalls > 0 && sub.stripeCustomerId) {
						const overageCostCents = Math.ceil(
							(overageCalls * PRICING.pricePerThousandCallsCents) / 1000,
						);

						// Skip (but still mark billed) if cost rounds below 1 cent.
						if (overageCostCents >= 1) {
							await stripe.invoiceItems.create(
								{
									customer: sub.stripeCustomerId,
									amount: overageCostCents,
									currency: "usd",
									description: `API call overage: ${overageCalls.toLocaleString()} calls beyond ${apiCallsIncluded.toLocaleString()} included`,
								},
								{
									idempotencyKey: `overage:${sub.organizationId}:${usage.periodStart.toISOString()}`,
								},
							);
						}
					}

					// Mark billed so no future run re-invoices this period.
					await db
						.update(usageRecords)
						.set({ billedAt: new Date(), updatedAt: new Date() })
						.where(eq(usageRecords.id, usage.id));
				}
			} catch (err) {
				console.error(`Usage reporting failed for org ${sub.organizationId}:`, err);
			}
		}

		// If we got fewer than BATCH_SIZE, we've processed all
		if (dueSubs.length < BATCH_SIZE) break;
	}

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
			.select({ id: organizationSubscriptions.id, organizationId: organizationSubscriptions.organizationId })
			.from(organizationSubscriptions)
			.where(and(...conditions))
			.orderBy(organizationSubscriptions.id)
			.limit(INACTIVE_BATCH_SIZE);

		if (inactiveSubs.length === 0) break;
		lastInactiveId = inactiveSubs[inactiveSubs.length - 1]!.id;

		for (const sub of inactiveSubs) {
			try {
				await syncOrgKeysToKV(env, db, sub.organizationId, "free", PRICING.freeCallsIncluded);
			} catch (err) {
				console.error(`Plan downgrade failed for org ${sub.organizationId}:`, err);
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

/**
 * Update all KV-cached API keys for an org with the given plan.
 */
async function syncOrgKeysToKV(
	env: Env,
	db: ReturnType<typeof createDb>,
	orgId: string,
	plan: "free" | "pro",
	callsIncluded: number,
): Promise<void> {
	const orgKeys = await db
		.select({ key: apikey.key })
		.from(apikey)
		.where(eq(apikey.organizationId, orgId));

	for (const k of orgKeys) {
		const existing = await env.KV.get<KVKeyData>(`apikey:${k.key}`, "json");
		if (existing) {
			existing.plan = plan;
			existing.calls_included = callsIncluded;
			// This path only downgrades to free; clear the Stripe billing period so
			// usage falls back to calendar month (free orgs have no Stripe window).
			existing.period_start = null;
			existing.period_end = null;
			await env.KV.put(`apikey:${k.key}`, JSON.stringify(existing), {
				expirationTtl: kvTtlForKey(existing.expires_at),
			});
		}
	}
}
