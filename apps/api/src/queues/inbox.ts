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
	for (const message of batch.messages) {
		const body = message.body;
		if (message.attempts >= MAX_RETRIES) {
			console.error(
				"[Inbox] Max retries exceeded, discarding:",
				JSON.stringify(body).slice(0, 200),
			);
			message.ack();
			continue;
		}
		try {
			await processInboxEvent(body, env, db);
			message.ack();
		} catch (err) {
			console.error("[Inbox] Processing failed:", err);
			const delaySeconds = 2 ** message.attempts;
			message.retry({ delaySeconds });
		}
	}
}
