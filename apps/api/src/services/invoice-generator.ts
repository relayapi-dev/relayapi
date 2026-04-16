import {
	createDb,
	organizationSubscriptions,
	usageRecords,
	apikey,
} from "@relayapi/db";
import { and, desc, eq, lte, inArray, isNotNull, gt } from "drizzle-orm";
import { createStripeClient } from "./stripe";
import { kvTtlForKey } from "../middleware/auth";
import { PRICING } from "../types";
import type { Env, KVKeyData } from "../types";

/**
 * Report metered usage to Stripe for active subscriptions whose billing
 * period has ended, and downgrade cancelled/expired subscriptions to free.
 * Called from the cron trigger in index.ts on the 1st of each month.
 *
 * Overage is added as an invoice item on the customer's upcoming invoice.
 * Stripe generates a single unified invoice with the $5 base + any overage.
 */
export async function generateInvoices(env: Env): Promise<void> {
	const now = new Date();

	// Only run on the 1st of the month to avoid unnecessary DB queries every minute
	if (now.getUTCDate() !== 1) return;

	const db = createDb(env.HYPERDRIVE.connectionString);
	const stripe = createStripeClient(env.STRIPE_SECRET_KEY);

	// --- 1. Report overage usage to Stripe for active subscriptions ---
	// Process in batches to handle any number of subscriptions
	let lastId: string | null = null;
	const BATCH_SIZE = 50;

	while (true) {
		const conditions = [
			eq(organizationSubscriptions.status, "active"),
			lte(organizationSubscriptions.currentPeriodEnd, now),
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
				// Look up the usage record for the completed period.
				// Query by periodEnd <= now to avoid race with webhooks that may
				// have already updated the subscription's currentPeriodStart/End.
				const [usage] = await db
					.select()
					.from(usageRecords)
					.where(
						and(
							eq(usageRecords.organizationId, sub.organizationId),
							lte(usageRecords.periodEnd, now),
							eq(usageRecords.periodStart, sub.currentPeriodStart),
						),
					)
					.limit(1);

				// If no exact match on periodStart (webhook may have rolled it),
				// fall back to the most recent completed period
				const effectiveUsage = usage ?? (await db
					.select()
					.from(usageRecords)
					.where(
						and(
							eq(usageRecords.organizationId, sub.organizationId),
							lte(usageRecords.periodEnd, now),
						),
					)
					.orderBy(desc(usageRecords.periodStart))
					.limit(1)
				)?.[0];

				const apiCallsCount = effectiveUsage?.apiCallsCount ?? 0;
				const apiCallsIncluded = PRICING.proCallsIncluded;
				const overageCalls = Math.max(0, apiCallsCount - apiCallsIncluded);

				// Add overage as an invoice item on the customer's next invoice
				// Stripe will include this alongside the $5 base subscription charge
				if (overageCalls > 0 && sub.stripeCustomerId) {
					const overageCostCents = Math.ceil(
						(overageCalls * PRICING.pricePerThousandCallsCents) / 1000,
					);

					// Skip if cost rounds to less than 1 cent
					if (overageCostCents < 1) continue;

					await stripe.invoiceItems.create({
						customer: sub.stripeCustomerId,
						amount: overageCostCents,
						currency: "usd",
						description: `API call overage: ${overageCalls.toLocaleString()} calls beyond ${apiCallsIncluded.toLocaleString()} included`,
					});
				}

				// Stripe handles invoice creation + period rolling automatically
				// Local invoice mirror is created via the invoice.finalized webhook
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
			await env.KV.put(`apikey:${k.key}`, JSON.stringify(existing), {
				expirationTtl: kvTtlForKey(existing.expires_at),
			});
		}
	}
}
