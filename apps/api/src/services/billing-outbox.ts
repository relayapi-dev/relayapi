import { apikey, billingOutbox, createDb, type Database } from "@relayapi/db";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { mapConcurrently } from "../lib/concurrency";
import type { Env } from "../types";
import { sendNotificationToOrg } from "./notification-manager";

const LEASE_MS = 5 * 60 * 1000;
const AUTH_CACHE_BATCH_SIZE = 100;
const AUTH_CACHE_DELETE_CONCURRENCY = 4;

interface BillingOutboxPayload {
	eventId?: string;
	invoiceId?: string;
	title?: string;
	body?: string;
	authCacheCursor?: string;
}

async function executeOutboxEffect(
	env: Env,
	db: Database,
	row: typeof billingOutbox.$inferSelect,
): Promise<BillingOutboxPayload | null> {
	const payload = row.payload as BillingOutboxPayload;

	if (row.kind === "auth_cache.refresh") {
		const conditions = [eq(apikey.organizationId, row.organizationId)];
		if (payload.authCacheCursor) {
			conditions.push(gt(apikey.key, payload.authCacheCursor));
		}
		const keys = await db
			.select({ key: apikey.key })
			.from(apikey)
			.where(and(...conditions))
			.orderBy(asc(apikey.key))
			.limit(AUTH_CACHE_BATCH_SIZE);
		await mapConcurrently(keys, AUTH_CACHE_DELETE_CONCURRENCY, ({ key }) =>
			env.KV.delete(`apikey:${key}`),
		);
		const lastKey = keys.at(-1)?.key;
		return keys.length === AUTH_CACHE_BATCH_SIZE && lastKey
			? { ...payload, authCacheCursor: lastKey }
			: null;
	}

	if (row.kind === "payment_failed.notify") {
		await sendNotificationToOrg(env, {
			type: "payment_failed",
			orgId: row.organizationId,
			title: payload.title ?? "Payment failed",
			body:
				payload.body ??
				"Your subscription payment failed. Please update your payment method to avoid losing Pro features.",
			data: { invoiceId: payload.invoiceId },
			occurrenceId: `billing-outbox:${row.id}:payment-failed`,
		});
		return null;
	}

	throw new Error(`Unsupported billing outbox kind: ${row.kind}`);
}

/**
 * Drain durable billing side effects without holding a DB transaction across
 * KV or email work. Stable outbox IDs make event reprocessing idempotent.
 */
export async function processBillingOutbox(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	limit = 50,
): Promise<number> {
	const now = new Date();
	const rows = await db
		.select()
		.from(billingOutbox)
		.where(
			or(
				and(
					inArray(billingOutbox.status, ["pending", "failed"]),
					lte(billingOutbox.nextAttemptAt, now),
				),
				and(
					eq(billingOutbox.status, "processing"),
					lte(billingOutbox.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(billingOutbox.nextAttemptAt), asc(billingOutbox.createdAt))
		.limit(limit);

	let processed = 0;
	for (const candidate of rows) {
		const claimNow = new Date();
		const [claimed] = await db
			.update(billingOutbox)
			.set({
				status: "processing",
				attempts: sql`${billingOutbox.attempts} + 1`,
				leaseToken: sql`${billingOutbox.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimNow.getTime() + LEASE_MS),
				updatedAt: claimNow,
			})
			.where(
				and(
					eq(billingOutbox.id, candidate.id),
					or(
						and(
							inArray(billingOutbox.status, ["pending", "failed"]),
							lte(billingOutbox.nextAttemptAt, claimNow),
						),
						and(
							eq(billingOutbox.status, "processing"),
							lte(billingOutbox.leaseExpiresAt, claimNow),
						),
					),
				),
			)
			.returning();
		if (!claimed) continue;

		try {
			const continuationPayload = await executeOutboxEffect(env, db, claimed);
			if (continuationPayload) {
				await db
					.update(billingOutbox)
					.set({
						status: "pending",
						payload: continuationPayload,
						nextAttemptAt: new Date(),
						leaseExpiresAt: null,
						lastError: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(billingOutbox.id, claimed.id),
							eq(billingOutbox.status, "processing"),
							eq(billingOutbox.leaseToken, claimed.leaseToken),
						),
					);
				continue;
			}
			const completed = await db
				.update(billingOutbox)
				.set({
					status: "succeeded",
					processedAt: new Date(),
					leaseExpiresAt: null,
					lastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(billingOutbox.id, claimed.id),
						eq(billingOutbox.status, "processing"),
						eq(billingOutbox.leaseToken, claimed.leaseToken),
					),
				)
				.returning({ id: billingOutbox.id });
			if (completed.length > 0) processed++;
		} catch (error) {
			const retrySeconds = Math.min(3600, 2 ** Math.min(claimed.attempts, 10));
			await db
				.update(billingOutbox)
				.set({
					status: "failed",
					nextAttemptAt: new Date(Date.now() + retrySeconds * 1000),
					leaseExpiresAt: null,
					lastError: error instanceof Error ? error.message : String(error),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(billingOutbox.id, claimed.id),
						eq(billingOutbox.status, "processing"),
						eq(billingOutbox.leaseToken, claimed.leaseToken),
					),
				);
		}
	}

	return processed;
}
