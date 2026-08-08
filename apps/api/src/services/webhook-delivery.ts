import {
	createDb,
	type Database,
	queueFailures,
	webhookDeliveries,
	webhookEndpoints,
	webhookEvents,
	webhookLogs,
} from "@relayapi/db";
import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { decryptToken } from "../lib/crypto";
import { customerWebhookManualReviewUntil } from "../lib/customer-webhook-policy";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { classifyPublicUrlWithDns } from "../lib/ssrf-guard";
import { encryptQueueFailurePayload } from "../queues/failures";
import type { Env } from "../types";
import { dispatchCustomerWebhookRepairExhaustedAlert } from "./operator-alerts";

export interface CustomerWebhookQueueMessage {
	type: "deliver_customer_webhook";
	delivery_id: string;
	operation_id: string;
	organization_id: string;
}

export interface WebhookDispatchOptions {
	workspaceId?: string | null;
	/**
	 * Stable ID for this logical business occurrence. Producers should derive it
	 * from their durable operation/resource transition so a retry addresses the
	 * same event while two equal payloads remain distinct occurrences.
	 */
	occurrenceId: string;
}

/** Drizzle transaction accepted by the source-side transactional outbox helper. */
export type WebhookTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

/**
 * Rows made durable with the source business transition. Queue handoff happens
 * only after that transaction commits; the scheduled dispatcher remains the
 * crash-recovery source of truth if the Worker stops before the handoff.
 */
export interface PersistedWebhookEvent {
	eventId: string | null;
	occurrenceId: string;
	deliveries: Array<{ id: string; organizationId: string }>;
}

interface WebhookEndpointRow {
	id: string;
	organizationId: string;
	workspaceId?: string | null;
	url: string;
	secretCiphertext: string;
	enabled?: boolean;
	events?: string[] | null;
}

interface WebhookDeliveryTarget {
	id: string;
}

export type WebhookDeliveryResult =
	| "not_due"
	| "succeeded"
	| "retry_scheduled"
	| "failed"
	| "unknown"
	| "manual_review";

const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_OPERATOR_AUTHORIZED_DELIVERY_ATTEMPTS = MAX_DELIVERY_ATTEMPTS + 1;
const DELIVERY_LEASE_MS = 2 * 60_000;
const DISPATCH_LEASE_MS = 60_000;
const DISPATCH_RETRY_MS = 30_000;
const DISPATCH_REDUNDANCY_MS = 5 * 60_000;
const MAX_DISPATCH_BATCH = 100;
const MAX_PRE_BOUNDARY_REPAIR_ATTEMPTS = 12;
const CUSTOMER_WEBHOOK_QUEUE_NAME = "relayapi-customer-webhooks";

async function stableId(prefix: string, value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${prefix}${hex.slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
	const normalize = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(normalize);
		if (input && typeof input === "object") {
			if (input instanceof Date) return input.toJSON();
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, child]) => [key, normalize(child)]),
			);
		}
		return input;
	};
	return JSON.stringify(normalize(value)) ?? "undefined";
}

function resolveOccurrenceId(occurrenceId: string): string {
	if (occurrenceId.length === 0 || occurrenceId.length > 256) {
		throw new Error("Webhook occurrenceId must contain 1-256 characters");
	}
	return occurrenceId;
}

export async function webhookEventIdForOccurrence(
	organizationId: string,
	occurrenceId: string,
): Promise<string> {
	return stableId("whe_", `${organizationId}\n${occurrenceId}`);
}

async function signPayload(
	payload: string,
	rawSecret: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(rawSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 1_000);
}

export function parseWebhookRetryAfter(
	header: string | null,
	nowMs = Date.now(),
): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) {
		return Math.min(Math.max(Number(trimmed), 1), 3_600);
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isFinite(dateMs)) return null;
	return Math.min(Math.max(Math.ceil((dateMs - nowMs) / 1_000), 1), 3_600);
}

export function webhookRetryDelaySeconds(
	attempt: number,
	retryAfter: string | null,
	nowMs = Date.now(),
): number {
	const requested = parseWebhookRetryAfter(retryAfter, nowMs);
	if (requested !== null) return requested;
	return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3_600);
}

export function webhookRepairDelaySeconds(attempt: number): number {
	return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 4 * 60 * 60);
}

export function webhookDeliveryAttemptLimit(
	operatorRetryRequestedAt: Date | null,
): number {
	return operatorRetryRequestedAt
		? MAX_OPERATOR_AUTHORIZED_DELIVERY_ATTEMPTS
		: MAX_DELIVERY_ATTEMPTS;
}

export function isRetryableWebhookStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

async function enqueueWebhookDeliveries(
	env: Env,
	db: Database,
	deliveries: Array<{ id: string; organizationId: string }>,
): Promise<void> {
	for (
		let offset = 0;
		offset < deliveries.length;
		offset += MAX_DISPATCH_BATCH
	) {
		const batch = deliveries.slice(offset, offset + MAX_DISPATCH_BATCH);
		const ids = batch.map(({ id }) => id);
		await env.CUSTOMER_WEBHOOK_QUEUE.sendBatch(
			batch.map(({ id, organizationId }) => ({
				body: {
					type: "deliver_customer_webhook",
					delivery_id: id,
					operation_id: id,
					organization_id: organizationId,
				} satisfies CustomerWebhookQueueMessage,
			})),
		);
		const now = new Date();
		await db
			.update(webhookDeliveries)
			.set({
				lastEnqueuedAt: now,
				nextDispatchAt: new Date(now.getTime() + DISPATCH_REDUNDANCY_MS),
				dispatchAttempts: sql`${webhookDeliveries.dispatchAttempts} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					inArray(webhookDeliveries.id, ids),
					eq(webhookDeliveries.status, "pending"),
					isNull(webhookDeliveries.requestMayHaveBeenSentAt),
				),
			);
	}
}

async function persistDeliveriesInTransaction(
	tx: WebhookTransaction,
	orgId: string,
	event: string,
	data: unknown,
	webhooks: WebhookDeliveryTarget[],
	options: WebhookDispatchOptions,
): Promise<PersistedWebhookEvent> {
	if (webhooks.length === 0) {
		return {
			eventId: null,
			occurrenceId: options.occurrenceId,
			deliveries: [],
		};
	}

	const eventId = await webhookEventIdForOccurrence(
		orgId,
		options.occurrenceId,
	);
	const deliveryRows = await Promise.all(
		webhooks.map(async (webhook) => ({
			id: await stableId("whd_", `${eventId}\n${webhook.id}`),
			webhookEventId: eventId,
			webhookId: webhook.id,
			organizationId: orgId,
		})),
	);

	const inserted = await tx
		.insert(webhookEvents)
		.values({
			id: eventId,
			occurrenceId: options.occurrenceId,
			organizationId: orgId,
			workspaceId: options.workspaceId ?? null,
			event,
			payload: data as Record<string, unknown>,
		})
		.onConflictDoNothing()
		.returning({ id: webhookEvents.id });
	if (!inserted[0]) {
		const [existing] = await tx
			.select({
				event: webhookEvents.event,
				payload: webhookEvents.payload,
				workspaceId: webhookEvents.workspaceId,
			})
			.from(webhookEvents)
			.where(
				and(
					eq(webhookEvents.id, eventId),
					eq(webhookEvents.organizationId, orgId),
					eq(webhookEvents.occurrenceId, options.occurrenceId),
				),
			)
			.limit(1);
		if (
			!existing ||
			existing.event !== event ||
			existing.workspaceId !== (options.workspaceId ?? null) ||
			canonicalJson(existing.payload) !== canonicalJson(data)
		) {
			throw new Error(
				"Webhook occurrenceId was reused with different event data",
			);
		}
	}
	if (inserted[0]) {
		const insertedDeliveries = await tx
			.insert(webhookDeliveries)
			.values(deliveryRows)
			.returning({
				id: webhookDeliveries.id,
				organizationId: webhookDeliveries.organizationId,
			});
		return {
			eventId,
			occurrenceId: options.occurrenceId,
			deliveries: insertedDeliveries,
		};
	}

	// The delivery rows created with the first occurrence are its immutable
	// endpoint snapshot. A retry must not deliver an old event to endpoints that
	// were created later; it only re-hands off rows that remain pending.
	const pending = await tx
		.select({
			id: webhookDeliveries.id,
			organizationId: webhookDeliveries.organizationId,
		})
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.webhookEventId, eventId),
				eq(webhookDeliveries.status, "pending"),
			),
		);
	return {
		eventId,
		occurrenceId: options.occurrenceId,
		deliveries: pending,
	};
}

/**
 * Persist an event and its endpoint fan-out inside the caller's source
 * transaction. This function performs no Queue or network I/O.
 */
export async function persistWebhookEventInTransaction(
	tx: WebhookTransaction,
	orgId: string,
	event: string,
	data: unknown,
	options: WebhookDispatchOptions,
): Promise<PersistedWebhookEvent> {
	const normalizedOptions = {
		workspaceId: options.workspaceId ?? null,
		occurrenceId: resolveOccurrenceId(options.occurrenceId),
	};
	const workspaceCondition = normalizedOptions.workspaceId
		? or(
				isNull(webhookEndpoints.workspaceId),
				eq(webhookEndpoints.workspaceId, normalizedOptions.workspaceId),
			)
		: isNull(webhookEndpoints.workspaceId);
	const webhooks = await tx
		.select({
			id: webhookEndpoints.id,
		})
		.from(webhookEndpoints)
		.where(
			and(
				eq(webhookEndpoints.organizationId, orgId),
				eq(webhookEndpoints.enabled, true),
				workspaceCondition,
				or(
					isNull(webhookEndpoints.events),
					sql`cardinality(${webhookEndpoints.events}) = 0`,
					sql`${event} = ANY(${webhookEndpoints.events})`,
				),
			),
		)
		.orderBy(webhookEndpoints.id);
	return persistDeliveriesInTransaction(
		tx,
		orgId,
		event,
		data,
		webhooks,
		normalizedOptions,
	);
}

/** Best-effort immediate handoff for rows already committed to the outbox. */
export async function enqueuePersistedWebhookEvent(
	env: Env,
	db: Database,
	persisted: PersistedWebhookEvent,
): Promise<void> {
	if (persisted.deliveries.length === 0) return;

	try {
		await enqueueWebhookDeliveries(env, db, persisted.deliveries);
	} catch (error) {
		// The durable pending rows are the source of truth. The scheduled
		// dispatcher will recover this handoff without making the source business
		// operation fail or wait for a Queue outage.
		console.error(
			JSON.stringify({
				event: "customer_webhook_handoff_failed",
				occurrence_id: persisted.occurrenceId,
				delivery_count: persisted.deliveries.length,
				error: safeError(error),
			}),
		);
	}
}

/** Durable fan-out for producers that do not already own a source transaction. */
export async function dispatchWebhookEvent(
	env: Env,
	db: Database,
	orgId: string,
	event: string,
	data: unknown,
	options: WebhookDispatchOptions,
): Promise<void> {
	if (!options) throw new Error("Webhook occurrenceId is required");
	const persisted = await db.transaction((tx) =>
		persistWebhookEventInTransaction(tx, orgId, event, data, options),
	);
	await enqueuePersistedWebhookEvent(env, db, persisted);
}

/** Persist and enqueue one event for an already-selected endpoint. */
export async function deliverWebhook(
	env: Env,
	webhook: WebhookEndpointRow,
	event: string,
	data: unknown,
	db: Database | undefined,
	occurrenceId: string,
): Promise<void> {
	const deliveryDb = db ?? createDb(env.HYPERDRIVE.connectionString);
	const subscribedEvents = webhook.events ?? [];
	const matchesEvent =
		subscribedEvents.length === 0 || subscribedEvents.includes(event);
	const persisted = await deliveryDb.transaction((tx) =>
		persistDeliveriesInTransaction(
			tx,
			webhook.organizationId,
			event,
			data,
			matchesEvent ? [webhook] : [],
			{
				workspaceId: webhook.workspaceId,
				occurrenceId: resolveOccurrenceId(occurrenceId),
			},
		),
	);
	await enqueuePersistedWebhookEvent(env, deliveryDb, persisted);
}

/**
 * Atomically reserve due outbox rows, enqueue them in one binding call, then
 * release the dispatch lease. A Worker death before `sendBatch` only delays the
 * row until lease expiry; a death after it can cause a duplicate Queue message,
 * which the fenced HTTP claim makes harmless.
 */
export async function dispatchPendingWebhookDeliveries(
	env: Env,
	limit = MAX_DISPATCH_BATCH,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const batchSize = Math.min(
		Math.max(Math.trunc(limit), 1),
		MAX_DISPATCH_BATCH,
	);
	const dispatchLeaseId = crypto.randomUUID();
	const claimed = (await db.execute(sql`
		WITH ranked AS MATERIALIZED (
			SELECT id,
			       next_dispatch_at,
			       row_number() OVER (
			         PARTITION BY organization_id
			         ORDER BY next_dispatch_at ASC, id ASC
			       ) AS tenant_rank
			  FROM webhook_deliveries
			 WHERE status = 'pending'
			   AND next_dispatch_at <= NOW()
			   AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at < NOW())
		),
		due AS (
			SELECT delivery.id
			  FROM ranked
			  JOIN webhook_deliveries AS delivery ON delivery.id = ranked.id
			 ORDER BY ranked.tenant_rank ASC, ranked.next_dispatch_at ASC, ranked.id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE OF delivery SKIP LOCKED
		)
		UPDATE webhook_deliveries AS delivery
		   SET dispatch_lease_id = ${dispatchLeaseId},
		       dispatch_lease_expires_at = NOW() + make_interval(secs => ${DISPATCH_LEASE_MS / 1_000}),
		       updated_at = NOW()
		  FROM due
		 WHERE delivery.id = due.id
		RETURNING delivery.id, delivery.organization_id
	`)) as unknown as Array<{ id: string; organization_id: string }>;
	if (claimed.length === 0) return 0;

	const ids = claimed.map(({ id }) => id);
	try {
		await env.CUSTOMER_WEBHOOK_QUEUE.sendBatch(
			claimed.map(({ id, organization_id }) => ({
				body: {
					type: "deliver_customer_webhook",
					delivery_id: id,
					operation_id: id,
					organization_id,
				} satisfies CustomerWebhookQueueMessage,
			})),
		);
		const now = new Date();
		await db
			.update(webhookDeliveries)
			.set({
				dispatchLeaseId: null,
				dispatchLeaseExpiresAt: null,
				lastEnqueuedAt: now,
				nextDispatchAt: new Date(now.getTime() + DISPATCH_REDUNDANCY_MS),
				dispatchAttempts: sql`${webhookDeliveries.dispatchAttempts} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(webhookDeliveries.dispatchLeaseId, dispatchLeaseId),
					inArray(webhookDeliveries.id, ids),
					eq(webhookDeliveries.status, "pending"),
					isNull(webhookDeliveries.requestMayHaveBeenSentAt),
				),
			);
		return ids.length;
	} catch (error) {
		const retryAt = new Date(Date.now() + DISPATCH_RETRY_MS);
		await db
			.update(webhookDeliveries)
			.set({
				dispatchLeaseId: null,
				dispatchLeaseExpiresAt: null,
				nextDispatchAt: retryAt,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(webhookDeliveries.dispatchLeaseId, dispatchLeaseId),
					eq(webhookDeliveries.status, "pending"),
					isNull(webhookDeliveries.requestMayHaveBeenSentAt),
				),
			);
		throw error;
	}
}

/**
 * Surface settled ambiguous outcomes in the operator failure ledger. The
 * deterministic synthetic message ID lets the Queue consumer and this
 * reconciler converge on one record.
 */
async function recordUnknownWebhookDeliveries(
	db: Database,
	env: Env,
	limit: number,
): Promise<number> {
	return db.transaction(async (tx) => {
		const unknown = (await tx.execute(sql`
			SELECT delivery.id,
			       delivery.organization_id,
			       delivery.attempts,
			       delivery.error
			  FROM webhook_deliveries AS delivery
			 WHERE delivery.status = 'manual_review'
			   AND delivery.manual_review_reason = 'http_outcome_unknown'
			   AND delivery.lease_expires_at IS NULL
			   AND NOT EXISTS (
			         SELECT 1
			           FROM queue_failures AS failure
			          WHERE failure.queue_name = ${CUSTOMER_WEBHOOK_QUEUE_NAME}
			            AND failure.message_id = 'delivery:' || delivery.id
			            AND failure.organization_ids @> ARRAY[delivery.organization_id]::text[]
			       )
			 ORDER BY delivery.updated_at ASC, delivery.id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		`)) as unknown as Array<{
			id: string;
			organization_id: string;
			attempts: number;
			error: string | null;
		}>;
		if (unknown.length === 0) return 0;
		const encryptedPayloads = await Promise.all(
			unknown.map((delivery) =>
				encryptQueueFailurePayload(
					env,
					CUSTOMER_WEBHOOK_QUEUE_NAME,
					`delivery:${delivery.id}`,
					{
						type: "deliver_customer_webhook",
						delivery_id: delivery.id,
						operation_id: delivery.id,
						organization_id: delivery.organization_id,
					},
				),
			),
		);

		await tx
			.insert(queueFailures)
			.values(
				unknown.map((delivery, index) => ({
					queueName: CUSTOMER_WEBHOOK_QUEUE_NAME,
					messageId: `delivery:${delivery.id}`,
					organizationIds: [delivery.organization_id],
					operationId: delivery.id,
					failureKind: "unknown_external_outcome" as const,
					attempts: delivery.attempts,
					...encryptedPayloads[index],
					error:
						delivery.error ??
						"Customer webhook transmission outcome is unknown",
				})),
			)
			.onConflictDoUpdate({
				target: [queueFailures.queueName, queueFailures.messageId],
				set: {
					attempts: sql`GREATEST(${queueFailures.attempts}, excluded.attempts)`,
					error: sql`excluded.error`,
					organizationIds: sql`(
						SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
						  FROM unnest(${queueFailures.organizationIds} || excluded.organization_ids) AS merged(value)
					)`,
				},
			});
		return unknown.length;
	});
}

/**
 * Recover expired pre-boundary claims, move post-boundary ambiguity into its
 * bounded operator-review state, and dispatch due outbox rows.
 */
export async function reconcileCustomerWebhookDeliveries(
	env: Env,
	limit = MAX_DISPATCH_BATCH,
): Promise<{
	recoveredPending: number;
	markedUnknown: number;
	unknownRecorded: number;
	enqueued: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const batchSize = Math.min(
		Math.max(Math.trunc(limit), 1),
		MAX_DISPATCH_BATCH,
	);
	const recovered = (await db.execute(sql`
		WITH expired AS (
			SELECT id
			  FROM webhook_deliveries
			 WHERE status IN ('in_flight', 'unknown')
			   AND lease_expires_at < NOW()
			 ORDER BY lease_expires_at ASC, id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
			UPDATE webhook_deliveries AS delivery
			   SET status = CASE
			                  WHEN delivery.status = 'in_flight'
			                   AND request_may_have_been_sent_at IS NULL
			                    THEN 'pending'
			                  ELSE 'manual_review'
			                END,
		       lease_token = lease_token + 1,
		       lease_expires_at = NULL,
		       next_attempt_at = CASE
		                           WHEN delivery.status = 'in_flight'
		                            AND request_may_have_been_sent_at IS NULL THEN NOW()
		                           ELSE next_attempt_at
		                         END,
			       next_dispatch_at = CASE
			                            WHEN delivery.status = 'in_flight'
			                             AND request_may_have_been_sent_at IS NULL THEN NOW()
			                            ELSE next_dispatch_at
			                          END,
			       manual_review_reason = CASE
			                                WHEN delivery.status = 'in_flight'
			                                 AND request_may_have_been_sent_at IS NULL
			                                  THEN NULL
			                                ELSE 'http_outcome_unknown'
			                              END,
			       manual_review_until = CASE
			                               WHEN delivery.status = 'in_flight'
			                                AND request_may_have_been_sent_at IS NULL
			                                 THEN NULL
			                               ELSE request_may_have_been_sent_at + interval '90 days'
			                             END,
			       error = CASE
		                 WHEN delivery.status = 'in_flight'
		                  AND request_may_have_been_sent_at IS NULL
		                   THEN 'delivery lease expired before the HTTP boundary'
		                 ELSE 'delivery lease expired after the HTTP boundary'
		               END,
		       updated_at = NOW()
		  FROM expired
		 WHERE delivery.id = expired.id
			RETURNING delivery.status
		`)) as unknown as Array<{ status: "pending" | "manual_review" }>;

	const markedUnknown = recovered.filter(
		({ status }) => status === "manual_review",
	).length;
	if (markedUnknown > 0) {
		console.error(
			JSON.stringify({
				event: "customer_webhook_reconciliation_required",
				count: markedUnknown,
			}),
		);
	}
	const unknownRecorded = await recordUnknownWebhookDeliveries(
		db,
		env,
		batchSize,
	);
	return {
		recoveredPending: recovered.length - markedUnknown,
		markedUnknown,
		unknownRecorded,
		enqueued: await dispatchPendingWebhookDeliveries(env, batchSize),
	};
}

async function settlePreBoundaryRepairFailure(
	db: Database,
	env: Env,
	input: {
		deliveryId: string;
		organizationId: string;
		leaseToken: number;
		repairAttempts: number;
		repairDeadlineAt: Date;
		error: string;
		now?: Date;
	},
): Promise<WebhookDeliveryResult> {
	const now = input.now ?? new Date();
	const repairAttempts = input.repairAttempts + 1;
	const exhausted =
		repairAttempts >= MAX_PRE_BOUNDARY_REPAIR_ATTEMPTS ||
		input.repairDeadlineAt.getTime() <= now.getTime();
	const nextAttemptAt = exhausted
		? null
		: new Date(
				now.getTime() + webhookRepairDelaySeconds(repairAttempts) * 1_000,
			);
	const persisted = await db
		.update(webhookDeliveries)
		.set({
			status: exhausted ? "manual_review" : "pending",
			repairAttempts,
			leaseExpiresAt: null,
			nextAttemptAt: nextAttemptAt ?? now,
			nextDispatchAt: nextAttemptAt ?? now,
			completedAt: null,
			manualReviewReason: exhausted ? "pre_http_repair_exhausted" : null,
			manualReviewUntil: exhausted
				? customerWebhookManualReviewUntil(input.repairDeadlineAt)
				: null,
			error: exhausted
				? `${input.error}; automatic repair exhausted`
				: input.error,
			updatedAt: now,
		})
		.where(
			and(
				eq(webhookDeliveries.id, input.deliveryId),
				eq(webhookDeliveries.leaseToken, input.leaseToken),
				eq(webhookDeliveries.status, "in_flight"),
			),
		)
		.returning({ id: webhookDeliveries.id });
	if (!persisted[0]) return "not_due";
	if (exhausted) {
		await dispatchCustomerWebhookRepairExhaustedAlert(
			{
				type: "customer_webhook_pre_boundary_repair_exhausted",
				organizationId: input.organizationId,
				deliveryId: input.deliveryId,
				repairAttempts,
				observedAt: now.toISOString(),
				occurrenceId: [
					"customer-webhook-repair-exhausted",
					input.deliveryId,
					input.repairDeadlineAt.toISOString(),
				].join(":"),
			},
			env,
		).catch(() => {
			console.error(
				JSON.stringify({
					event: "customer_webhook_operator_alert_failed",
					organization_id: input.organizationId,
					delivery_id: input.deliveryId,
				}),
			);
		});
		return "manual_review";
	}
	return "retry_scheduled";
}

/** Execute one stable delivery under a fenced pre-network lease. */
export async function performWebhookDelivery(
	env: Env,
	deliveryId: string,
): Promise<WebhookDeliveryResult> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const [delivery] = await db
		.update(webhookDeliveries)
		.set({
			status: "in_flight",
			claimedAt: now,
			leaseToken: sql`${webhookDeliveries.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
			requestMayHaveBeenSentAt: null,
			completedAt: null,
			manualReviewReason: null,
			manualReviewUntil: null,
			error: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(webhookDeliveries.id, deliveryId),
				or(
					and(
						isNull(webhookDeliveries.operatorRetryRequestedAt),
						lt(webhookDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
					),
					and(
						isNotNull(webhookDeliveries.operatorRetryRequestedAt),
						lt(
							webhookDeliveries.attempts,
							MAX_OPERATOR_AUTHORIZED_DELIVERY_ATTEMPTS,
						),
					),
				),
				or(
					and(
						eq(webhookDeliveries.status, "pending"),
						lte(webhookDeliveries.nextAttemptAt, now),
					),
					and(
						eq(webhookDeliveries.status, "in_flight"),
						lt(webhookDeliveries.leaseExpiresAt, now),
						isNull(webhookDeliveries.requestMayHaveBeenSentAt),
					),
				),
			),
		)
		.returning();
	if (!delivery) {
		const [existing] = await db
			.select({
				status: webhookDeliveries.status,
				leaseExpiresAt: webhookDeliveries.leaseExpiresAt,
				manualReviewReason: webhookDeliveries.manualReviewReason,
			})
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, deliveryId))
			.limit(1);
		return (existing?.status === "unknown" &&
			existing.leaseExpiresAt === null) ||
			(existing?.status === "manual_review" &&
				existing.manualReviewReason === "http_outcome_unknown")
			? "unknown"
			: "not_due";
	}
	const fence = and(
		eq(webhookDeliveries.id, deliveryId),
		eq(webhookDeliveries.leaseToken, delivery.leaseToken),
	);

	const [[endpoint], [event]] = await Promise.all([
		db
			.select()
			.from(webhookEndpoints)
			.where(eq(webhookEndpoints.id, delivery.webhookId))
			.limit(1),
		db
			.select()
			.from(webhookEvents)
			.where(eq(webhookEvents.id, delivery.webhookEventId))
			.limit(1),
	]);
	if (!endpoint || !event || !endpoint.enabled) {
		await db
			.update(webhookDeliveries)
			.set({
				status: "failed",
				completedAt: new Date(),
				leaseExpiresAt: null,
				error: "Endpoint unavailable",
				updatedAt: new Date(),
			})
			.where(and(fence, eq(webhookDeliveries.status, "in_flight")));
		return "failed";
	}

	const urlSafety = await classifyPublicUrlWithDns(endpoint.url);
	if (urlSafety === "indeterminate") {
		const result = await settlePreBoundaryRepairFailure(db, env, {
			deliveryId,
			organizationId: delivery.organizationId,
			leaseToken: delivery.leaseToken,
			repairAttempts: delivery.repairAttempts,
			repairDeadlineAt: delivery.repairDeadlineAt,
			error: "Endpoint DNS safety could not be determined; delivery deferred",
		});
		console.error(
			JSON.stringify({
				event: "customer_webhook_dns_validation_deferred",
				webhook_id: endpoint.id,
				delivery_id: deliveryId,
			}),
		);
		return result;
	}
	if (urlSafety === "blocked") {
		const disabled = await db.transaction(async (tx) => {
			const disabledEndpoint = await tx
				.update(webhookEndpoints)
				.set({ enabled: false })
				.where(
					and(
						eq(webhookEndpoints.id, endpoint.id),
						eq(webhookEndpoints.url, endpoint.url),
						eq(webhookEndpoints.secretCiphertext, endpoint.secretCiphertext),
						eq(webhookEndpoints.enabled, true),
					),
				)
				.returning({ id: webhookEndpoints.id });
			if (!disabledEndpoint[0]) {
				await tx
					.update(webhookDeliveries)
					.set({
						status: "pending",
						leaseExpiresAt: null,
						nextAttemptAt: new Date(),
						nextDispatchAt: new Date(),
						error: "Endpoint changed during URL safety validation",
						updatedAt: new Date(),
					})
					.where(and(fence, eq(webhookDeliveries.status, "in_flight")));
				return false;
			}
			const failedDelivery = await tx
				.update(webhookDeliveries)
				.set({
					status: "failed",
					completedAt: new Date(),
					leaseExpiresAt: null,
					error: "Endpoint resolved to a blocked address",
					updatedAt: new Date(),
				})
				.where(and(fence, eq(webhookDeliveries.status, "in_flight")))
				.returning({ id: webhookDeliveries.id });
			if (!failedDelivery[0]) {
				throw new Error("Webhook delivery lease lost during endpoint disable");
			}
			return true;
		});
		return disabled ? "failed" : "retry_scheduled";
	}

	let rawSecret: string;
	try {
		rawSecret = await decryptToken(
			endpoint.secretCiphertext,
			env.ENCRYPTION_KEY,
			{
				recordId: endpoint.id,
				field: "secret_ciphertext",
			},
		);
	} catch (error) {
		const result = await settlePreBoundaryRepairFailure(db, env, {
			deliveryId,
			organizationId: delivery.organizationId,
			leaseToken: delivery.leaseToken,
			repairAttempts: delivery.repairAttempts,
			repairDeadlineAt: delivery.repairDeadlineAt,
			error: "Signing secret could not be decrypted; delivery deferred",
		});
		console.error(
			JSON.stringify({
				event: "customer_webhook_signing_key_unavailable",
				webhook_id: endpoint.id,
				delivery_id: deliveryId,
				error: safeError(error),
			}),
		);
		return result;
	}

	const payload = JSON.stringify({
		id: deliveryId,
		event: event.event,
		data: event.payload,
		timestamp: event.createdAt.toISOString(),
	});
	const signature = await signPayload(payload, rawSecret);
	const attemptOrdinal = delivery.attempts + 1;
	const attemptLimit = webhookDeliveryAttemptLimit(
		delivery.operatorRetryRequestedAt,
	);
	const requestStartedAt = new Date();
	const boundary = await db
		.update(webhookDeliveries)
		.set({
			status: "unknown",
			attempts: sql`${webhookDeliveries.attempts} + 1`,
			requestMayHaveBeenSentAt: requestStartedAt,
			updatedAt: requestStartedAt,
		})
		.where(and(fence, eq(webhookDeliveries.status, "in_flight")))
		.returning({ id: webhookDeliveries.id });
	if (!boundary[0]) return "not_due";

	const start = Date.now();
	try {
		const response = await fetchWithTimeout(endpoint.url, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				"X-RelayAPI-Event": event.event,
				"X-RelayAPI-Delivery-Id": deliveryId,
				"X-RelayAPI-Signature": `sha256=${signature}`,
			},
			body: payload,
			timeout: 5_000,
		});
		await response.body?.cancel().catch(() => {});
		const responseTimeMs = Date.now() - start;
		const retryable = isRetryableWebhookStatus(response.status);
		const retryScheduled = retryable && attemptOrdinal < attemptLimit;
		const completedAt = retryScheduled ? null : new Date();
		const error = response.ok
			? null
			: retryScheduled
				? `HTTP ${response.status}; retry scheduled`
				: `HTTP ${response.status}`;
		const retryAt = retryScheduled
			? new Date(
					Date.now() +
						webhookRetryDelaySeconds(
							attemptOrdinal,
							response.headers.get("retry-after"),
						) *
							1_000,
				)
			: null;
		const result: WebhookDeliveryResult = response.ok
			? "succeeded"
			: retryScheduled
				? "retry_scheduled"
				: "failed";

		await db.transaction(async (tx) => {
			const persisted = await tx
				.update(webhookDeliveries)
				.set({
					status: response.ok
						? "succeeded"
						: retryScheduled
							? "pending"
							: "failed",
					statusCode: response.status,
					responseTimeMs,
					completedAt,
					leaseExpiresAt: null,
					nextAttemptAt: retryAt ?? delivery.nextAttemptAt,
					nextDispatchAt: retryAt ?? delivery.nextDispatchAt,
					error,
					updatedAt: new Date(),
				})
				.where(and(fence, eq(webhookDeliveries.status, "unknown")))
				.returning({ id: webhookDeliveries.id });
			if (!persisted[0]) return;
			await tx.insert(webhookLogs).values({
				webhookId: endpoint.id,
				webhookEventId: event.id,
				deliveryId: delivery.id,
				organizationId: delivery.organizationId,
				attemptOrdinal,
				attemptKind: "delivery",
				outcome: result,
				statusCode: response.status,
				responseTimeMs,
				error,
			});
		});
		return result;
	} catch (error) {
		const responseTimeMs = Date.now() - start;
		const attemptError = safeError(error);
		await db.transaction(async (tx) => {
			const persisted = await tx
				.update(webhookDeliveries)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					responseTimeMs,
					manualReviewReason: "http_outcome_unknown",
					manualReviewUntil: customerWebhookManualReviewUntil(requestStartedAt),
					error: attemptError,
					updatedAt: new Date(),
				})
				.where(and(fence, eq(webhookDeliveries.status, "unknown")))
				.returning({ id: webhookDeliveries.id });
			if (!persisted[0]) return;
			await tx.insert(webhookLogs).values({
				webhookId: endpoint.id,
				webhookEventId: event.id,
				deliveryId: delivery.id,
				organizationId: delivery.organizationId,
				attemptOrdinal,
				attemptKind: "delivery",
				outcome: "unknown",
				statusCode: null,
				responseTimeMs,
				error: attemptError,
			});
		});
		// Transmission errors may have crossed the customer boundary. The stable
		// delivery ID is retained for operator-side reconciliation; automatic
		// replay would risk duplicating the customer's effect.
		return "unknown";
	}
}
