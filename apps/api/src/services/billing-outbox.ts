import {
	apikey,
	BILLING_OUTBOX_KINDS,
	billingOutbox,
	type BillingOutboxKind,
	createDb,
	type Database,
	organizationSubscriptions,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import {
	exponentialBackoffSeconds,
	statusFromProviderError,
} from "../lib/async-policy";
import { mapConcurrently } from "../lib/concurrency";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env } from "../types";
import { sendNotificationToOrg } from "./notification-manager";

const LEASE_MS = 5 * 60 * 1000;
const AUTH_CACHE_BATCH_SIZE = 100;
const AUTH_CACHE_DELETE_CONCURRENCY = 4;
const BILLING_OUTBOX_MAX_ATTEMPTS = 12;
const BILLING_OUTBOX_RETRY = {
	baseSeconds: 2,
	capSeconds: 60 * 60,
	jitterRatio: 0.2,
} as const;

interface BillingOutboxPayload {
	eventId?: string;
	invoiceId?: string;
	title?: string;
	body?: string;
	authCacheCursor?: string;
	stripeSubscriptionId?: string;
}

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Stage subscription cancellation in the same transaction that accepts tenant
 * deletion. The deterministic ID makes repeated deletion requests idempotent,
 * and this outbox is drained independently even while legal hold pauses purge.
 */
export async function stageSubscriptionCancellation(
	db: Database | BillingTransaction,
	organizationId: string,
	stripeSubscriptionId: string | null | undefined,
): Promise<void> {
	if (!stripeSubscriptionId) return;
	await db
		.insert(billingOutbox)
		.values({
			id: `tenant-delete:${organizationId}:subscription-cancel`,
			organizationId,
			kind: "subscription.cancel",
			payload: { stripeSubscriptionId },
		})
		.onConflictDoNothing();
}

async function executeOutboxEffect(
	env: Env,
	db: Database,
	row: typeof billingOutbox.$inferSelect,
): Promise<BillingOutboxPayload | null> {
	const payload = row.payload as BillingOutboxPayload;
	if (!BILLING_OUTBOX_KINDS.includes(row.kind as BillingOutboxKind)) {
		throw new Error(`Unsupported billing outbox kind: ${row.kind}`);
	}
	const kind = row.kind as BillingOutboxKind;
	switch (kind) {
		case "auth_cache.refresh": {
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
		case "payment_failed.notify":
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
		case "subscription.cancel": {
			const subscriptionId = payload.stripeSubscriptionId;
			if (subscriptionId && !isSelfHosted(env)) {
				const stripe = new Stripe(env.STRIPE_SECRET_KEY);
				try {
					await stripe.subscriptions.cancel(
						subscriptionId,
						{},
						{
							idempotencyKey: `relayapi:tenant-delete:${row.organizationId}:subscription`,
						},
					);
				} catch (error) {
					if (
						!(
							error instanceof Stripe.errors.StripeInvalidRequestError &&
							error.statusCode === 404
						)
					) {
						throw error;
					}
				}
			}
			// Self-hosted deployments deliberately have no Stripe client. If stale
			// hosted identifiers exist in an imported database, resolve locally
			// without trapping erasure behind an unavailable integration.
			await db
				.update(organizationSubscriptions)
				.set({
					status: "cancelled",
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				})
				.where(
					eq(organizationSubscriptions.organizationId, row.organizationId),
				);
			return null;
		}
		default: {
			const exhaustive: never = kind;
			throw new Error(`Unsupported billing outbox kind: ${exhaustive}`);
		}
	}
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
	// Make the attempt budget terminal before selecting work. This also repairs
	// a worker that crashed after its final claim and whose lease later expired.
	await db
		.update(billingOutbox)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			manualReviewAt: now,
			lastErrorClass: "retry_exhausted",
			lastError: sql`COALESCE(${billingOutbox.lastError}, 'Billing outbox automatic attempt budget exhausted')`,
			updatedAt: now,
		})
		.where(
			and(
				sql`${billingOutbox.attempts} >= ${BILLING_OUTBOX_MAX_ATTEMPTS}`,
				or(
					eq(billingOutbox.status, "failed"),
					and(
						eq(billingOutbox.status, "processing"),
						lte(billingOutbox.leaseExpiresAt, now),
					),
				),
			),
		);
	const rows = await db
		.select()
		.from(billingOutbox)
		.where(
			or(
				and(
					inArray(billingOutbox.status, ["pending", "failed"]),
					lte(billingOutbox.nextAttemptAt, now),
					sql`${billingOutbox.attempts} < ${BILLING_OUTBOX_MAX_ATTEMPTS}`,
				),
				and(
					eq(billingOutbox.status, "processing"),
					lte(billingOutbox.leaseExpiresAt, now),
					sql`${billingOutbox.attempts} < ${BILLING_OUTBOX_MAX_ATTEMPTS}`,
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
							sql`${billingOutbox.attempts} < ${BILLING_OUTBOX_MAX_ATTEMPTS}`,
						),
						and(
							eq(billingOutbox.status, "processing"),
							lte(billingOutbox.leaseExpiresAt, claimNow),
							sql`${billingOutbox.attempts} < ${BILLING_OUTBOX_MAX_ATTEMPTS}`,
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
						// `attempts` is a consecutive failure budget, not a page
						// counter. A successful cursor page must not strand large
						// organizations after twelve 100-key batches.
						attempts: 0,
						payload: continuationPayload,
						nextAttemptAt: new Date(),
						leaseExpiresAt: null,
						lastError: null,
						lastErrorClass: null,
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
					lastErrorClass: null,
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
			const status = statusFromProviderError(error);
			const permanent =
				status !== null &&
				status >= 400 &&
				status < 500 &&
				status !== 408 &&
				status !== 425 &&
				status !== 429;
			const exhausted = claimed.attempts >= BILLING_OUTBOX_MAX_ATTEMPTS;
			const retrySeconds = exponentialBackoffSeconds(
				claimed.attempts,
				BILLING_OUTBOX_RETRY,
				`${claimed.id}:${claimed.attempts}`,
			);
			const terminal = permanent || exhausted;
			await db
				.update(billingOutbox)
				.set({
					status: terminal ? "manual_review" : "failed",
					nextAttemptAt: new Date(Date.now() + retrySeconds * 1000),
					leaseExpiresAt: null,
					lastError: error instanceof Error ? error.message : String(error),
					lastErrorClass: permanent
						? "permanent"
						: exhausted
							? "retry_exhausted"
							: "transient",
					manualReviewAt: terminal ? new Date() : null,
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
