import type { CustomerWebhookQueueMessage } from "../services/webhook-delivery";
import { performWebhookDelivery } from "../services/webhook-delivery";
import type { Env } from "../types";
import { recordQueueFailure, recordQueueFailureRecord } from "./failures";

// Keep a small per-batch pool so slow customer endpoints do not serialize the
// whole Queue batch. Workers queue requests beyond the six connections still
// waiting for response headers, and delivery responses are cancelled promptly.
const LOCAL_DELIVERY_CONCURRENCY = 5;

function isCustomerWebhookQueueMessage(
	value: unknown,
): value is CustomerWebhookQueueMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		body.type === "deliver_customer_webhook" &&
		typeof body.delivery_id === "string" &&
		body.delivery_id.length > 0 &&
		typeof body.operation_id === "string" &&
		body.operation_id.length > 0 &&
		typeof body.organization_id === "string" &&
		body.organization_id.length > 0
	);
}

async function consumeMessage(
	message: Message<CustomerWebhookQueueMessage>,
	queueName: string,
	env: Env,
): Promise<void> {
	if (!isCustomerWebhookQueueMessage(message.body)) {
		await recordQueueFailure(
			env,
			queueName,
			message,
			"permanent_input",
			"Invalid customer webhook message",
		);
		message.ack();
		return;
	}
	const body = message.body;
	try {
		const result = await performWebhookDelivery(env, body.delivery_id);
		if (result === "unknown") {
			await recordQueueFailureRecord(env, {
				queueName,
				messageId: `delivery:${body.delivery_id}`,
				attempts: message.attempts,
				payload: body,
				kind: "unknown_external_outcome",
				error: "Customer webhook transmission outcome is unknown",
				organizationIds: [body.organization_id],
				operationId: body.delivery_id,
			});
			console.error(
				JSON.stringify({
					event: "customer_webhook_reconciliation_required",
					delivery_id: body.delivery_id,
				}),
			);
		}
		message.ack();
	} catch (error) {
		console.error("[customer-webhook] delivery worker failed", error);
		message.retry({ delaySeconds: Math.min(2 ** message.attempts, 300) });
	}
}

export async function consumeCustomerWebhookQueue(
	batch: MessageBatch<CustomerWebhookQueueMessage>,
	env: Env,
): Promise<void> {
	let nextMessage = 0;
	const workerCount = Math.min(
		LOCAL_DELIVERY_CONCURRENCY,
		batch.messages.length,
	);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			for (;;) {
				const message = batch.messages[nextMessage++];
				if (!message) return;
				await consumeMessage(message, batch.queue, env);
			}
		}),
	);
}
