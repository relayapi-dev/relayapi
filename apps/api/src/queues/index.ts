import type { Env } from "../types";
import { consumeAdsQueue } from "./ads";
import { consumeCustomerWebhookQueue } from "./customer-webhook";
import { consumeDeadLetterQueue } from "./dead-letter";
import { consumeEmailQueue } from "./email";
import { consumeInboxQueue } from "./inbox";
import { consumeMediaCleanupQueue } from "./media-cleanup";
import { consumeMediaProcessingQueue } from "./media-processing";
import { consumePublishQueue } from "./publish";
import { normalizeQueueClass } from "./queue-class";
import { consumeQueueRescue } from "./queue-rescue";
import { consumeSyncQueue } from "./sync";
import { consumeTokenRefreshQueue } from "./token-refresh";
import { consumeToolsQueue } from "./tools";

export async function handleQueueBatch(
	batch: MessageBatch,
	env: Env,
): Promise<void> {
	const queueClass = normalizeQueueClass(batch.queue);
	if (!queueClass) {
		throw new Error(`No queue consumer registered for ${batch.queue}`);
	}
	if (queueClass.role === "rescue") {
		return consumeQueueRescue(batch, env);
	}
	if (queueClass.role === "dead-letter") {
		return consumeDeadLetterQueue(batch, env);
	}

	switch (queueClass.capability) {
		case "customer-webhooks":
			return consumeCustomerWebhookQueue(
				batch as Parameters<typeof consumeCustomerWebhookQueue>[0],
				env,
			);
		case "publish":
			return consumePublishQueue(
				batch as Parameters<typeof consumePublishQueue>[0],
				env,
			);
		case "email":
			return consumeEmailQueue(
				batch as Parameters<typeof consumeEmailQueue>[0],
				env,
			);
		case "media-cleanup":
			return consumeMediaCleanupQueue(
				batch as Parameters<typeof consumeMediaCleanupQueue>[0],
				env,
			);
		case "media-processing":
			return consumeMediaProcessingQueue(
				batch as Parameters<typeof consumeMediaProcessingQueue>[0],
				env,
			);
		case "refresh":
			return consumeTokenRefreshQueue(
				batch as Parameters<typeof consumeTokenRefreshQueue>[0],
				env,
			);
		case "inbox":
			return consumeInboxQueue(
				batch as Parameters<typeof consumeInboxQueue>[0],
				env,
			);
		case "tools":
			return consumeToolsQueue(
				batch as Parameters<typeof consumeToolsQueue>[0],
				env,
			);
		case "ads":
			return consumeAdsQueue(
				batch as Parameters<typeof consumeAdsQueue>[0],
				env,
			);
		case "sync":
			return consumeSyncQueue(
				batch as Parameters<typeof consumeSyncQueue>[0],
				env,
			);
	}
}
