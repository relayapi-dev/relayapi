import {
	createDb,
	emailDeliveries,
	inboundWebhookEvents,
	postTargets,
	queueFailures,
	webhookDeliveries,
} from "@relayapi/db";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getAdCreationReplayState } from "./ad-creation-operations";

const REPLAY_CLAIM_MS = 5 * 60 * 1000;

function organizationScope(organizationId: string) {
	return sql`${queueFailures.organizationIds} @> ARRAY[${organizationId}]::text[]`;
}

function sourceQueueName(queueName: string): string {
	return queueName.endsWith("-dlq") ? queueName.slice(0, -4) : queueName;
}

function replayQueue(env: Env, queueName: string): Queue | undefined {
	return {
		"relayapi-publish": env.PUBLISH_QUEUE,
		"relayapi-email": env.EMAIL_QUEUE,
		"relayapi-refresh": env.REFRESH_QUEUE,
		"relayapi-inbox": env.INBOX_QUEUE,
		"relayapi-inbox-raw": env.INBOX_QUEUE,
		"relayapi-tools": env.TOOLS_QUEUE,
		"relayapi-ads": env.ADS_QUEUE,
		"relayapi-sync": env.SYNC_QUEUE,
		"relayapi-customer-webhooks": env.CUSTOMER_WEBHOOK_QUEUE,
	}[queueName];
}

export async function replayQueueFailure(
	env: Env,
	failureId: string,
	organizationId: string,
): Promise<{ replayed: boolean; reason?: string }> {
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

	const queueName = sourceQueueName(candidate.queueName);
	if (
		!candidate.payload ||
		typeof candidate.payload !== "object" ||
		Array.isArray(candidate.payload)
	) {
		return { replayed: false, reason: "Failure payload is not replayable" };
	}
	const payload = candidate.payload as Record<string, unknown>;
	const paidOperationId =
		queueName === "relayapi-ads" &&
		(payload.type === "create_ad" || payload.type === "boost_post")
			? typeof payload.operation_id === "string" &&
				payload.operation_id.length > 0
				? payload.operation_id
				: candidate.messageId
			: null;
	const rawReceiptId =
		(queueName === "relayapi-inbox" || queueName === "relayapi-inbox-raw") &&
		payload.type === "raw_platform_webhook" &&
		typeof payload.receipt_id === "string"
			? payload.receipt_id
			: null;
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
	const queue = replayQueue(env, queueName);
	if (!queue) {
		return {
			replayed: false,
			reason: `Queue ${queueName} is not replayable here`,
		};
	}

	// Read-only operation-aware checks happen before the claim. No status or
	// provider state is changed until this failure wins the atomic fence below.
	if (queueName === "relayapi-publish" && typeof payload.post_id === "string") {
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
		queueName === "relayapi-ads" &&
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

	if (queueName === "relayapi-email" && typeof payload.id === "string") {
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

	if (
		queueName === "relayapi-customer-webhooks" &&
		typeof payload.delivery_id === "string"
	) {
		const [delivery] = await db
			.select({ status: webhookDeliveries.status })
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.id, payload.delivery_id),
					eq(webhookDeliveries.organizationId, organizationId),
				),
			)
			.limit(1);
		if (
			!delivery ||
			delivery.status === "unknown" ||
			delivery.status === "succeeded" ||
			delivery.status === "in_flight"
		) {
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

	try {
		// Reset operation projections only after the replay claim is durable.
		if (queueName === "relayapi-email" && typeof payload.id === "string") {
			const reset = await db
				.update(emailDeliveries)
				.set({
					status: "pending",
					requestMayHaveBeenSentAt: null,
					providerMessageId: null,
					error: null,
					completedAt: null,
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
		if (
			queueName === "relayapi-customer-webhooks" &&
			typeof payload.delivery_id === "string"
		) {
			const now = new Date();
			const reset = await db
				.update(webhookDeliveries)
				.set({
					status: "pending",
					attempts: 0,
					leaseExpiresAt: null,
					claimedAt: null,
					requestMayHaveBeenSentAt: null,
					completedAt: null,
					statusCode: null,
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
						eq(webhookDeliveries.id, payload.delivery_id),
						eq(webhookDeliveries.organizationId, organizationId),
						inArray(webhookDeliveries.status, ["pending", "failed"]),
					),
				)
				.returning({ id: webhookDeliveries.id });
			if (reset.length === 0) {
				throw new Error("Webhook delivery changed state before replay reset");
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

		// Customer deliveries use their DB outbox/reconciler. Resetting the durable
		// row above is the replay handoff; a second direct Queue send would race it.
		if (queueName !== "relayapi-customer-webhooks") {
			const replayPayload = paidOperationId
				? { ...payload, operation_id: paidOperationId }
				: payload;
			await queue.send(replayPayload);
		}
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
				queueName,
			});
		}
		return { replayed: true };
	} catch (error) {
		// Queue send errors are ambiguous. Never reopen the claim automatically:
		// doing so could duplicate a send that reached Cloudflare before the error.
		await db
			.update(queueFailures)
			.set({
				status: "replay_unknown",
				replayError: error instanceof Error ? error.message : String(error),
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
			reason:
				"Replay send outcome is unknown; reconcile before any further attempt",
		};
	}
}

/** Crash reconciliation: an expired claim is ambiguous, never auto-replayed. */
export async function reconcileQueueReplayClaims(
	env: Env,
	requestedLimit = 100,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.max(1, Math.min(requestedLimit, 500));
	const now = new Date();
	const expired = await db
		.select({ id: queueFailures.id })
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
	const updated = await db
		.update(queueFailures)
		.set({
			status: "replay_unknown",
			replayError:
				"Replay worker ended before the Queue send could be confirmed",
			replayClaimExpiresAt: null,
		})
		.where(
			and(
				inArray(
					queueFailures.id,
					expired.map((row) => row.id),
				),
				eq(queueFailures.status, "replay_claimed"),
				lt(queueFailures.replayClaimExpiresAt, now),
			),
		)
		.returning({ id: queueFailures.id });
	return updated.length;
}
