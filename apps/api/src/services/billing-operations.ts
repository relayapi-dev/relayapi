import { billingOperations, createDb, type Database } from "@relayapi/db";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Env } from "../types";
import { createStripeClient } from "./stripe";

const LEASE_MS = 10 * 60 * 1000;

async function findStripeInvoiceItem(
	stripe: Stripe,
	operation: typeof billingOperations.$inferSelect,
): Promise<Stripe.InvoiceItem | null> {
	// Stripe may prune idempotency keys after 24 hours. The durable operation ID
	// is also attached as metadata, so reconcile the provider before any retry
	// whose outcome was unknown.
	const items = stripe.invoiceItems.list({
		customer: operation.stripeCustomerId,
		created: {
			gte: Math.max(0, Math.floor(operation.createdAt.getTime() / 1000) - 300),
		},
		limit: 100,
	});
	for await (const item of items) {
		if (item.metadata?.relayapi_operation_id === operation.id) return item;
	}
	return null;
}

async function markSucceeded(
	db: Database,
	operation: typeof billingOperations.$inferSelect,
	invoiceItemId: string,
): Promise<boolean> {
	const [completed] = await db
		.update(billingOperations)
		.set({
			status: "succeeded",
			stripeInvoiceItemId: invoiceItemId,
			leaseExpiresAt: null,
			lastError: null,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(billingOperations.id, operation.id),
				eq(billingOperations.status, "processing"),
				eq(billingOperations.leaseToken, operation.leaseToken),
			),
		)
		.returning({ id: billingOperations.id });
	return Boolean(completed);
}

/**
 * Process durable overage mutations. Unknown provider outcomes are reconciled
 * by metadata before retrying, rather than assuming Stripe still retains the
 * request idempotency key.
 */
export async function processOverageBillingOperations(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	stripe?: Stripe,
	limit = 50,
): Promise<number> {
	const client = stripe ?? (await createStripeClient(env.STRIPE_SECRET_KEY));
	const now = new Date();
	const candidates = await db
		.select()
		.from(billingOperations)
		.where(
			or(
				and(
					inArray(billingOperations.status, ["pending", "failed", "unknown"]),
					lte(billingOperations.nextAttemptAt, now),
				),
				and(
					eq(billingOperations.status, "processing"),
					lte(billingOperations.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(
			asc(billingOperations.nextAttemptAt),
			asc(billingOperations.createdAt),
		)
		.limit(limit);

	let succeeded = 0;
	for (const candidate of candidates) {
		const claimNow = new Date();
		const [claimed] = await db
			.update(billingOperations)
			.set({
				status: "processing",
				attempts: sql`${billingOperations.attempts} + 1`,
				leaseToken: sql`${billingOperations.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimNow.getTime() + LEASE_MS),
				updatedAt: claimNow,
			})
			.where(
				and(
					eq(billingOperations.id, candidate.id),
					or(
						and(
							inArray(billingOperations.status, [
								"pending",
								"failed",
								"unknown",
							]),
							lte(billingOperations.nextAttemptAt, claimNow),
						),
						and(
							eq(billingOperations.status, "processing"),
							lte(billingOperations.leaseExpiresAt, claimNow),
						),
					),
				),
			)
			.returning();
		if (!claimed) continue;

		try {
			if (
				candidate.status === "unknown" ||
				candidate.status === "processing" ||
				candidate.attempts > 0
			) {
				const existing = await findStripeInvoiceItem(client, claimed);
				if (existing) {
					if (await markSucceeded(db, claimed, existing.id)) succeeded++;
					continue;
				}
			}

			const invoiceItem = await client.invoiceItems.create(
				{
					customer: claimed.stripeCustomerId,
					amount: claimed.amountCents,
					currency: claimed.currency,
					description: claimed.description,
					metadata: {
						relayapi_operation_id: claimed.id,
						usage_bucket_settlement_id: claimed.usageBucketSettlementId,
						organization_id: claimed.organizationId,
					},
				},
				{ idempotencyKey: claimed.idempotencyKey },
			);
			if (await markSucceeded(db, claimed, invoiceItem.id)) succeeded++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const statusCode =
				error && typeof error === "object" && "statusCode" in error
					? (error as { statusCode?: number }).statusCode
					: undefined;
			// Validation/auth failures are known terminal failures. Network, timeout,
			// 409, 429 and 5xx outcomes can be ambiguous and must reconcile first.
			const terminal = Boolean(
				statusCode &&
					statusCode >= 400 &&
					statusCode < 500 &&
					statusCode !== 409 &&
					statusCode !== 429,
			);
			await db
				.update(billingOperations)
				.set({
					status: terminal ? "terminal_failed" : "unknown",
					nextAttemptAt: new Date(
						Date.now() +
							Math.min(3600, 2 ** Math.min(claimed.attempts, 10)) * 1000,
					),
					leaseExpiresAt: null,
					lastError: message,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(billingOperations.id, claimed.id),
						eq(billingOperations.status, "processing"),
						eq(billingOperations.leaseToken, claimed.leaseToken),
					),
				);
		}
	}

	return succeeded;
}
