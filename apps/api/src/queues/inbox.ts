import { createDb } from "@relayapi/db";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import { processInboxEvent } from "../services/inbox-event-processor";
import type { Env } from "../types";

const MAX_RETRIES = 5;

export async function consumeInboxQueue(
	batch: MessageBatch<InboxQueueMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	// Process the batch's messages concurrently. Each message keeps its own
	// ack/retry semantics; one slow event (e.g. a dead customer webhook endpoint
	// inside processInboxEvent) no longer head-of-line blocks the rest of the
	// batch, which previously serialized realtime notify + automation replies.
	await Promise.allSettled(
		batch.messages.map(async (message) => {
			const body = message.body;
			if (message.attempts >= MAX_RETRIES) {
				console.error(
					"[Inbox] Max retries exceeded, discarding:",
					JSON.stringify(body).slice(0, 200),
				);
				message.ack();
				return;
			}
			try {
				await processInboxEvent(body, env, db);
				message.ack();
			} catch (err) {
				console.error("[Inbox] Processing failed:", err);
				const delaySeconds = 2 ** message.attempts;
				message.retry({ delaySeconds });
			}
		}),
	);
}
