import {
	handleDeadLetterMessage,
	processEmailMessage,
} from "../lib/email-queue/consumer";
import type { EmailQueueMessage } from "../lib/email-queue/types";
import type { Env } from "../types";

const MAX_RETRIES = 5;

export async function consumeEmailQueue(
	batch: MessageBatch<EmailQueueMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;

		if (message.attempts > MAX_RETRIES) {
			handleDeadLetterMessage(body);
			message.ack();
			continue;
		}

		const result = await processEmailMessage(body, env.RESEND_API_KEY);

		if (result.success) {
			message.ack();
		} else if (result.shouldRetry) {
			const delaySeconds = 2 ** message.attempts;
			console.log(
				`[Queue] Retrying email in ${delaySeconds}s (attempt ${message.attempts})`,
			);
			message.retry({ delaySeconds });
		} else {
			console.error(
				`[Queue] Non-retryable email error, discarding: ${result.error}`,
			);
			message.ack();
		}
	}
}
