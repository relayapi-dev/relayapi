import { createDb } from "@relayapi/db";
import {
	isMediaEventMessage,
	type MediaEventMessage,
	processMediaEvent,
	RetryableMediaError,
} from "../services/media-reliability";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

/**
 * Consume R2 object notifications for the media library. Retryable thumbnail
 * state is persisted before the message is retried; exhausted messages flow to
 * relayapi-media-cleanup-dlq, whose generic consumer durably records them in
 * queue_failures for the scheduled reconciler.
 */
export async function consumeMediaCleanupQueue(
	batch: MessageBatch<MediaEventMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	for (const message of batch.messages) {
		if (
			!isMediaEventMessage(message.body, {
				account: env.R2_EVENT_ACCOUNT_ID,
				bucket: env.R2_MEDIA_BUCKET_NAME,
			})
		) {
			console.error("[Media Event] Invalid R2 event payload", {
				messageId: message.id,
			});
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Invalid R2 media event payload",
			);
			message.ack();
			continue;
		}

		try {
			await processMediaEvent(db, env, message.body);
			message.ack();
		} catch (error) {
			console.error(
				`[Media Event] ${message.body.action} failed for ${message.body.object.key}:`,
				error,
			);
			message.retry({
				delaySeconds:
					error instanceof RetryableMediaError ? error.delaySeconds : 30,
			});
		}
	}
}
