import type { Env } from "../types";
import { recordQueueFailure } from "./failures";
import { createQueueRescueEnvelope, persistQueueRescue } from "./queue-rescue";

/**
 * Persist DLQ messages in Postgres before acknowledging them. The original
 * operation/message id remains in the payload so replay tooling can make an
 * operation-aware decision instead of blindly repeating an external call.
 */
export async function consumeDeadLetterQueue(
	batch: MessageBatch<unknown>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"dead_letter",
				`Message exhausted retries in ${batch.queue}`,
			);
			console.error("[Queue DLQ] durable failure recorded", {
				queue: batch.queue,
				messageId: message.id,
				attempts: message.attempts,
			});
			message.ack();
		} catch (databaseError) {
			console.error("[Queue DLQ] PostgreSQL ledger unavailable", {
				queue: batch.queue,
				messageId: message.id,
				error:
					databaseError instanceof Error
						? databaseError.message
						: String(databaseError),
			});

			const envelope = await createQueueRescueEnvelope(
				env,
				batch.queue,
				message,
			);
			try {
				await persistQueueRescue(env, envelope);
				console.error("[Queue DLQ] failure copied to R2 rescue ledger", {
					queue: batch.queue,
					messageId: message.id,
				});
				message.ack();
			} catch (r2Error) {
				try {
					// Independent Queue handoff is a final fallback. The consumer writes
					// the same deterministic R2 key, so a send/ACK crash cannot duplicate.
					await env.QUEUE_RESCUE_QUEUE.send(envelope);
					message.ack();
				} catch (queueError) {
					console.error("[Queue DLQ] every rescue sink failed", {
						queue: batch.queue,
						messageId: message.id,
						r2Error:
							r2Error instanceof Error ? r2Error.message : String(r2Error),
						queueError:
							queueError instanceof Error
								? queueError.message
								: String(queueError),
					});
					message.retry({ delaySeconds: Math.min(2 ** message.attempts, 900) });
				}
			}
		}
	}
}
