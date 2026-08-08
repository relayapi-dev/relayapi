import {
	createDb,
	emailDeliveries,
	inboundWebhookEvents,
	postTargets,
	queueFailures,
	webhookDeliveries,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { CUSTOMER_WEBHOOK_REPAIR_WINDOW_MS } from "../lib/customer-webhook-policy";
import { decryptQueueFailurePayload } from "../queues/failures";
import {
	normalizeQueueClass,
	type WorkQueueCapability,
} from "../queues/queue-class";
import type { Env } from "../types";
import { getAdCreationReplayState } from "./ad-creation-operations";

const REPLAY_CLAIM_MS = 5 * 60 * 1000;

function organizationScope(organizationId: string) {
	return sql`${queueFailures.organizationIds} @> ARRAY[${organizationId}]::text[]`;
}

function replayQueue(
	env: Env,
	queueClass: WorkQueueCapability,
): Queue | undefined {
	switch (queueClass) {
		case "publish":
			return env.PUBLISH_QUEUE;
		case "email":
			return env.EMAIL_QUEUE;
		case "refresh":
			return env.REFRESH_QUEUE;
		case "inbox":
			return env.INBOX_QUEUE;
		case "tools":
			return env.TOOLS_QUEUE;
		case "ads":
			return env.ADS_QUEUE;
		case "sync":
			return env.SYNC_QUEUE;
		case "customer-webhooks":
			return env.CUSTOMER_WEBHOOK_QUEUE;
		case "media-cleanup":
			return undefined;
	}
}

export async function replayQueueFailure(
	env: Env,
	failureId: string,
	organizationId: string,
): Promise<{ replayed: boolean; reason?: string; outcomeUnknown?: true }> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const [candidate] = await db
		.select()
		.from(queueFailures)
		.where(
			and(
				eq(queueFailures.id, failureId),
				organizationScope(organizationId),
				eq(queueFailures.status, "unresolved"),
			),
		)
		.limit(1);
	if (!candidate) {
		return { replayed: false, reason: "Failure not found or already claimed" };
	}
	if (candidate.failureKind === "unknown_external_outcome") {
		return {
			replayed: false,
			reason: "Unknown external outcome requires reconciliation",
		};
	}

	const normalizedQueue = normalizeQueueClass(candidate.queueName);
	const queueClass =
		normalizedQueue?.role === "rescue"
			? null
			: (normalizedQueue?.capability ?? null);
	const payload = await decryptQueueFailurePayload(env, candidate).catch(
		() => null,
	);
	if (!payload) {
		return { replayed: false, reason: "Failure payload is not replayable" };
	}
	const paidOperationId =
		queueClass === "ads" &&
		(payload.type === "create_ad" || payload.type === "boost_post")
			? typeof payload.operation_id === "string" &&
				payload.operation_id.length > 0
				? payload.operation_id
				: candidate.messageId
			: null;
	const rawReceiptId =
		queueClass === "inbox" &&
		payload.type === "raw_platform_webhook" &&
		typeof payload.receipt_id === "string"
			? payload.receipt_id
			: null;
	const customerWebhookDeliveryId =
		queueClass === "customer-webhooks" &&
		typeof payload.delivery_id === "string" &&
		payload.delivery_id.length > 0
			? payload.delivery_id
			: null;
	if (queueClass === "customer-webhooks" && !customerWebhookDeliveryId) {
		return {
			replayed: false,
			reason: "Customer webhook failure payload has no delivery identity",
		};
	}
	if (
		rawReceiptId &&
		(candidate.organizationIds.length !== 1 ||
			candidate.organizationIds[0] !== organizationId)
	) {
		return {
			replayed: false,
			reason:
				"Shared raw receipts require internal reconciliation and cannot be tenant-replayed",
		};
	}
	const queue = queueClass ? replayQueue(env, queueClass) : undefined;
	if (!queue) {
		return {
			replayed: false,
			reason: `Queue ${candidate.queueName} is not replayable here`,
		};
	}

	// Read-only operation-aware checks happen before the claim. No status or
	// provider state is changed until this failure wins the atomic fence below.
	if (queueClass === "publish" && typeof payload.post_id === "string") {
		const unknown = await db
			.select({ id: postTargets.id })
			.from(postTargets)
			.where(
				and(
					eq(postTargets.postId, payload.post_id),
					eq(postTargets.organizationId, organizationId),
					eq(postTargets.deliveryState, "unknown"),
				),
			)
			.limit(1);
		if (unknown.length > 0) {
			return {
				replayed: false,
				reason: "Publish target has an unknown provider outcome",
			};
		}
	}
	if (
		queueClass === "ads" &&
		(payload.type === "create_ad" || payload.type === "boost_post")
	) {
		const replayState = await getAdCreationReplayState(
			db,
			organizationId,
			payload.type,
			paidOperationId as string,
		);
		if (replayState !== "safe" && replayState !== "not_started") {
			return {
				replayed: false,
				reason:
					replayState === "completed"
						? "Paid operation is already completed"
						: replayState === "lease_active"
							? "Paid operation is still processing"
							: "Paid operation has an unknown provider outcome and requires reconciliation",
			};
		}
	}

	if (queueClass === "email" && typeof payload.id === "string") {
		const [email] = await db
			.select({ status: emailDeliveries.status })
			.from(emailDeliveries)
			.where(eq(emailDeliveries.id, payload.id))
			.limit(1);
		if (
			email?.status === "unknown" ||
			email?.status === "sent" ||
			email?.status === "pending"
		) {
			return {
				replayed: false,
				reason: `Email is ${email.status}; reconcile before replay`,
			};
		}
	}

	if (customerWebhookDeliveryId) {
		const [delivery] = await db
			.select({ status: webhookDeliveries.status })
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.id, customerWebhookDeliveryId),
					eq(webhookDeliveries.organizationId, organizationId),
				),
			)
			.limit(1);
		if (!delivery || !["pending", "failed"].includes(delivery.status)) {
			return {
				replayed: false,
				reason: delivery
					? `Webhook delivery is ${delivery.status}; reconcile before replay`
					: "Webhook delivery no longer exists",
			};
		}
	}

	if (rawReceiptId) {
		const [receipt] = await db
			.select({ status: inboundWebhookEvents.status })
			.from(inboundWebhookEvents)
			.where(
				and(
					eq(inboundWebhookEvents.id, rawReceiptId),
					sql`${inboundWebhookEvents.organizationIds} = ARRAY[${organizationId}]::text[]`,
				),
			)
			.limit(1);
		if (receipt?.status !== "failed") {
			return {
				replayed: false,
				reason: receipt
					? `Raw receipt is ${receipt.status}; only failed receipts are replayable`
					: "Raw receipt no longer exists",
			};
		}
	}

	const claimToken = crypto.randomUUID();
	const [failure] = await db
		.update(queueFailures)
		.set({
			status: "replay_claimed",
			replayClaimToken: claimToken,
			replayClaimExpiresAt: new Date(Date.now() + REPLAY_CLAIM_MS),
			replayRequestedAt: new Date(),
			replayError: null,
		})
		.where(
			and(
				eq(queueFailures.id, candidate.id),
				rawReceiptId
					? sql`${queueFailures.organizationIds} = ARRAY[${organizationId}]::text[]`
					: organizationScope(organizationId),
				eq(queueFailures.status, "unresolved"),
			),
		)
		.returning();
	if (!failure) {
		return { replayed: false, reason: "Failure was concurrently claimed" };
	}

	// Customer webhook replay is a durable DB-outbox handoff, not a new Queue
	// send. Commit the delivery reset and failure-ledger resolution together so
	// a crash can leave either an untouched claim or a completed handoff, never
	// an externally ambiguous half-state.
	if (customerWebhookDeliveryId) {
		try {
			await db.transaction(async (tx) => {
				const now = new Date();
				const repairDeadlineAt = new Date(
					now.getTime() + CUSTOMER_WEBHOOK_REPAIR_WINDOW_MS,
				);
				const reset = await tx
					.update(webhookDeliveries)
					.set({
						status: "pending",
						attempts: 0,
						repairAttempts: 0,
						repairDeadlineAt,
						leaseToken: sql`${webhookDeliveries.leaseToken} + 1`,
						leaseExpiresAt: null,
						claimedAt: null,
						requestMayHaveBeenSentAt: null,
						completedAt: null,
						statusCode: null,
						responseTimeMs: null,
						manualReviewReason: null,
						manualReviewUntil: null,
						operatorIntervenedAt: null,
						operatorRetryRequestedAt: null,
						error: null,
						nextAttemptAt: now,
						dispatchLeaseId: null,
						dispatchLeaseExpiresAt: null,
						nextDispatchAt: now,
						lastEnqueuedAt: null,
						dispatchAttempts: 0,
						updatedAt: now,
					})
					.where(
						and(
							eq(webhookDeliveries.id, customerWebhookDeliveryId),
							eq(webhookDeliveries.organizationId, organizationId),
							inArray(webhookDeliveries.status, ["pending", "failed"]),
							isNull(webhookDeliveries.operatorIntervenedAt),
							isNull(webhookDeliveries.operatorRetryRequestedAt),
						),
					)
					.returning({ id: webhookDeliveries.id });
				if (reset.length === 0) {
					throw new Error("Webhook delivery changed state before replay reset");
				}

				const resolved = await tx
					.update(queueFailures)
					.set({
						status: "replayed",
						resolvedAt: now,
						replayClaimExpiresAt: null,
					})
					.where(
						and(
							eq(queueFailures.id, failure.id),
							eq(queueFailures.status, "replay_claimed"),
							eq(queueFailures.replayClaimToken, claimToken),
						),
					)
					.returning({ id: queueFailures.id });
				if (resolved.length === 0) {
					throw new Error(
						"Webhook replay claim changed before durable handoff",
					);
				}
			});
			return { replayed: true };
		} catch (error) {
			const replayError =
				error instanceof Error ? error.message : String(error);
			const released = await db
				.update(queueFailures)
				.set({
					status: "unresolved",
					replayClaimToken: null,
					replayClaimExpiresAt: null,
					replayError,
				})
				.where(
					and(
						eq(queueFailures.id, failure.id),
						eq(queueFailures.status, "replay_claimed"),
						eq(queueFailures.replayClaimToken, claimToken),
					),
				)
				.returning({ id: queueFailures.id })
				.catch(() => []);
			if (released.length > 0) {
				return {
					replayed: false,
					reason:
						"Webhook replay did not commit its durable handoff; refresh before retrying",
				};
			}

			// A lost commit response is resolved by the atomically updated ledger.
			let current: { status: string } | undefined;
			try {
				[current] = await db
					.select({ status: queueFailures.status })
					.from(queueFailures)
					.where(eq(queueFailures.id, failure.id))
					.limit(1);
			} catch {
				current = undefined;
			}
			if (current?.status === "replayed") {
				return { replayed: true };
			}
			return {
				replayed: false,
				outcomeUnknown: true,
				reason:
					"Webhook replay state could not be confirmed; wait for claim reconciliation before another attempt",
			};
		}
	}

	let queueSendMayHaveOccurred = false;
	try {
		// Reset operation projections only after the replay claim is durable.
		if (queueClass === "email" && typeof payload.id === "string") {
			const reset = await db
				.update(emailDeliveries)
				.set({
					status: "pending",
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt: null,
					providerMessageId: null,
					error: null,
					completedAt: null,
					nextAttemptAt: new Date(),
					nextDispatchAt: new Date(),
					dispatchLeaseExpiresAt: null,
				})
				.where(
					and(
						eq(emailDeliveries.id, payload.id),
						eq(emailDeliveries.status, "failed"),
					),
				)
				.returning({ id: emailDeliveries.id });
			if (reset.length === 0) {
				throw new Error("Email changed state before replay reset");
			}
		}
		if (rawReceiptId) {
			const reset = await db
				.update(inboundWebhookEvents)
				.set({ status: "failed", attempts: 0, claimedAt: null })
				.where(
					and(
						eq(inboundWebhookEvents.id, rawReceiptId),
						eq(inboundWebhookEvents.status, "failed"),
						sql`${inboundWebhookEvents.organizationIds} = ARRAY[${organizationId}]::text[]`,
					),
				)
				.returning({ id: inboundWebhookEvents.id });
			if (reset.length === 0) {
				throw new Error(
					"Raw receipt changed state or tenant scope before replay reset",
				);
			}
		}

		const replayPayload = paidOperationId
			? { ...payload, operation_id: paidOperationId }
			: payload;
		queueSendMayHaveOccurred = true;
		await queue.send(replayPayload);
		const resolved = await db
			.update(queueFailures)
			.set({
				status: "replayed",
				resolvedAt: new Date(),
				replayClaimExpiresAt: null,
			})
			.where(
				and(
					eq(queueFailures.id, failure.id),
					eq(queueFailures.status, "replay_claimed"),
					eq(queueFailures.replayClaimToken, claimToken),
				),
			)
			.returning({ id: queueFailures.id });
		if (resolved.length === 0) {
			console.error("[Queue replay] send succeeded but claim fence was lost", {
				failureId: failure.id,
				queueName: candidate.queueName,
				queueClass,
			});
		}
		return { replayed: true };
	} catch (error) {
		const replayError = error instanceof Error ? error.message : String(error);
		if (!queueSendMayHaveOccurred) {
			await db
				.update(queueFailures)
				.set({
					status: "unresolved",
					replayClaimToken: null,
					replayClaimExpiresAt: null,
					replayError,
				})
				.where(
					and(
						eq(queueFailures.id, failure.id),
						eq(queueFailures.status, "replay_claimed"),
						eq(queueFailures.replayClaimToken, claimToken),
					),
				);
			return {
				replayed: false,
				reason:
					"Replay stopped before the Queue send boundary; refresh before retrying",
			};
		}

		// Queue send errors are ambiguous. Never reopen the claim automatically:
		// doing so could duplicate a send that reached Cloudflare before the error.
		await db
			.update(queueFailures)
			.set({
				status: "replay_unknown",
				replayError,
				replayClaimExpiresAt: null,
			})
			.where(
				and(
					eq(queueFailures.id, failure.id),
					eq(queueFailures.status, "replay_claimed"),
					eq(queueFailures.replayClaimToken, claimToken),
				),
			);
		return {
			replayed: false,
			outcomeUnknown: true,
			reason:
				"Replay send outcome is unknown; reconcile before any further attempt",
		};
	}
}

/**
 * Crash reconciliation distinguishes the atomic customer-webhook DB handoff
 * from paths that may have crossed a Cloudflare Queue send boundary.
 */
export async function reconcileQueueReplayClaims(
	env: Env,
	requestedLimit = 100,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.max(1, Math.min(requestedLimit, 500));
	const now = new Date();
	const expired = await db
		.select({ id: queueFailures.id, queueName: queueFailures.queueName })
		.from(queueFailures)
		.where(
			and(
				eq(queueFailures.status, "replay_claimed"),
				lt(queueFailures.replayClaimExpiresAt, now),
			),
		)
		.orderBy(asc(queueFailures.replayClaimExpiresAt))
		.limit(limit);
	if (expired.length === 0) return 0;
	const durableWebhookIds = expired
		.filter(
			(row) =>
				normalizeQueueClass(row.queueName)?.capability === "customer-webhooks",
		)
		.map((row) => row.id);
	const queueSendIds = expired
		.filter(
			(row) =>
				normalizeQueueClass(row.queueName)?.capability !== "customer-webhooks",
		)
		.map((row) => row.id);

	let reconciled = 0;
	if (durableWebhookIds.length > 0) {
		const reopened = await db
			.update(queueFailures)
			.set({
				status: "unresolved",
				replayClaimToken: null,
				replayClaimExpiresAt: null,
				replayError:
					"Replay worker ended before the atomic webhook handoff committed; safe to inspect and retry",
			})
			.where(
				and(
					inArray(queueFailures.id, durableWebhookIds),
					eq(queueFailures.status, "replay_claimed"),
					lt(queueFailures.replayClaimExpiresAt, now),
				),
			)
			.returning({ id: queueFailures.id });
		reconciled += reopened.length;
	}
	if (queueSendIds.length > 0) {
		const unknown = await db
			.update(queueFailures)
			.set({
				status: "replay_unknown",
				replayError:
					"Replay worker ended before the Queue send could be confirmed",
				replayClaimExpiresAt: null,
			})
			.where(
				and(
					inArray(queueFailures.id, queueSendIds),
					eq(queueFailures.status, "replay_claimed"),
					lt(queueFailures.replayClaimExpiresAt, now),
				),
			)
			.returning({ id: queueFailures.id });
		reconciled += unknown.length;
	}
	return reconciled;
}
