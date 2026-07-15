import { createDb, inboundWebhookEvents, organization } from "@relayapi/db";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { decryptToken } from "../lib/crypto";
import type { AnyInboxQueueMessage as InboxQueueMessage } from "../routes/platform-webhooks";
import { processInboxEvent } from "../services/inbox-event-processor";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

const INBOX_MESSAGE_CONCURRENCY = 4;
const COMPLETED_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RAW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function captureOrganizationId(value: unknown, ids: Set<string>): void {
	if (!value || typeof value !== "object") return;
	const body = value as Record<string, unknown>;
	for (const name of ["organization_id", "org_id"]) {
		if (typeof body[name] === "string") ids.add(body[name]);
	}
}

/** Track the tenant fan-out without adding lookups to the provider ACK path. */
function createTrackedInboxEnv(env: Env, organizationIds: Set<string>): Env {
	const trackedQueue = new Proxy(env.INBOX_QUEUE, {
		get(target, property) {
			if (property === "send") {
				return (body: unknown, options?: QueueSendOptions) => {
					captureOrganizationId(body, organizationIds);
					return target.send(body, options);
				};
			}
			if (property === "sendBatch") {
				return (
					messages: Iterable<MessageSendRequest<unknown>>,
					options?: QueueSendBatchOptions,
				) => {
					const buffered = [...messages];
					for (const message of buffered) {
						captureOrganizationId(message.body, organizationIds);
					}
					return target.sendBatch(buffered, options);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(env, {
		get(target, property, receiver) {
			if (property === "INBOX_QUEUE") return trackedQueue;
			return Reflect.get(target, property, receiver);
		},
	});
}

async function persistRawReceiptOutcome(
	db: ReturnType<typeof createDb>,
	receipt: typeof inboundWebhookEvents.$inferSelect,
	status: "completed" | "failed",
	organizationIds: Set<string>,
	error?: unknown,
): Promise<void> {
	const claimedAt = receipt.claimedAt;
	if (!claimedAt) {
		throw new Error(`Raw receipt ${receipt.id} has no claim timestamp`);
	}
	await db.transaction(async (tx) => {
		const outcomeAt = new Date();
		let activeOrganizationIds: string[] = [];
		if (organizationIds.size > 0) {
			const rows = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						inArray(organization.id, [...organizationIds]),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("key share");
			activeOrganizationIds = rows.map(({ id }) => id);
		}

		await tx
			.update(inboundWebhookEvents)
			.set(
				status === "completed"
					? {
							status,
							processedAt: outcomeAt,
							organizationIds: activeOrganizationIds,
							// Keep the encrypted source briefly for incident replay, then the
							// retention job redacts it while preserving the dedupe receipt.
							expiresAt: new Date(
								outcomeAt.getTime() + COMPLETED_RAW_RETENTION_MS,
							),
							lastError: null,
						}
					: {
							status,
							lastError: error instanceof Error ? error.message : String(error),
							organizationIds: activeOrganizationIds,
							expiresAt: new Date(
								outcomeAt.getTime() + FAILED_RAW_RETENTION_MS,
							),
						},
			)
			.where(
				and(
					eq(inboundWebhookEvents.id, receipt.id),
					eq(inboundWebhookEvents.status, "processing"),
					eq(inboundWebhookEvents.claimedAt, claimedAt),
				),
			);
	});
}

export async function consumeInboxQueue(
	batch: MessageBatch<InboxQueueMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	// Process the batch's messages concurrently. Each message keeps its own
	// ack/retry semantics; one slow event (e.g. a dead customer webhook endpoint
	// inside processInboxEvent) no longer head-of-line blocks the rest of the
	// batch, which previously serialized realtime notify + automation replies.
	const results: PromiseSettledResult<void>[] = [];
	for (
		let offset = 0;
		offset < batch.messages.length;
		offset += INBOX_MESSAGE_CONCURRENCY
	) {
		const chunk = batch.messages.slice(
			offset,
			offset + INBOX_MESSAGE_CONCURRENCY,
		);
		results.push(
			...(await Promise.allSettled(
				chunk.map(async (message) => {
					const body = message.body;
					try {
						if (body.type === "raw_platform_webhook") {
							if (
								typeof body.receipt_id !== "string" ||
								body.receipt_id.length === 0
							) {
								await recordQueueFailure(
									env,
									batch.queue,
									message,
									"permanent_input",
									"Raw inbox message is missing receipt_id",
								);
								message.ack();
								return;
							}
							const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
							const claimTime = new Date();
							const claimed = await db
								.update(inboundWebhookEvents)
								.set({
									status: "processing",
									claimedAt: claimTime,
									attempts: sql`${inboundWebhookEvents.attempts} + 1`,
									lastError: null,
								})
								.where(
									and(
										eq(inboundWebhookEvents.id, body.receipt_id),
										isNull(inboundWebhookEvents.redactedAt),
										gt(inboundWebhookEvents.expiresAt, claimTime),
										or(
											inArray(inboundWebhookEvents.status, [
												"received",
												"queued",
												"failed",
											]),
											and(
												eq(inboundWebhookEvents.status, "processing"),
												lt(inboundWebhookEvents.claimedAt, staleBefore),
											),
										),
									),
								)
								.returning();
							const receipt = claimed[0];
							if (receipt) {
								const organizationIds = new Set(receipt.organizationIds ?? []);
								try {
									const payload = await decryptToken(
										receipt.payloadCiphertext,
										env.ENCRYPTION_KEY,
										{
											recordId: receipt.id,
											field: "payload_ciphertext",
										},
									);
									const { processRawPlatformWebhook } = await import(
										"../routes/platform-webhooks"
									);
									await processRawPlatformWebhook(
										receipt.provider,
										payload,
										createTrackedInboxEnv(env, organizationIds),
										receipt.signatureMetadata,
									);
									await persistRawReceiptOutcome(
										db,
										receipt,
										"completed",
										organizationIds,
									);
								} catch (error) {
									await persistRawReceiptOutcome(
										db,
										receipt,
										"failed",
										organizationIds,
										error,
									);
									throw error;
								}
							} else {
								// A duplicate delivery for a receipt already being processed or
								// completed is a valid no-op. A nonexistent receipt is malformed
								// durable input and must be recorded before the Queue message is
								// acknowledged.
								const [existing] = await db
									.select({ status: inboundWebhookEvents.status })
									.from(inboundWebhookEvents)
									.where(eq(inboundWebhookEvents.id, body.receipt_id))
									.limit(1);
								if (!existing) {
									await recordQueueFailure(
										env,
										batch.queue,
										message,
										"permanent_input",
										`Raw inbox receipt ${body.receipt_id} does not exist`,
									);
								}
							}
						} else {
							await processInboxEvent(body, env, db);
						}
						message.ack();
					} catch (err) {
						console.error("[Inbox] Processing failed:", err);
						const delaySeconds = 2 ** message.attempts;
						message.retry({ delaySeconds });
					}
				}),
			)),
		);
	}
	for (const [index, result] of results.entries()) {
		if (result.status !== "rejected") continue;
		const message = batch.messages[index];
		if (!message) continue;
		console.error("[Inbox] handler escaped without ACK/retry", {
			messageId: message.id,
			error:
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason),
		});
		message.retry({ delaySeconds: Math.min(2 ** message.attempts, 900) });
	}
}
