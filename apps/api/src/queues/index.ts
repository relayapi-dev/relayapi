import type { Env } from "../types";
import { consumeAdsQueue } from "./ads";
import { consumeCustomerWebhookQueue } from "./customer-webhook";
import { consumeDeadLetterQueue } from "./dead-letter";
import { consumeEmailQueue } from "./email";
import { consumeInboxQueue } from "./inbox";
import { consumeMediaCleanupQueue } from "./media-cleanup";
import { consumePublishQueue } from "./publish";
import { consumeQueueRescue } from "./queue-rescue";
import { consumeSyncQueue } from "./sync";
import { consumeTokenRefreshQueue } from "./token-refresh";
import { consumeToolsQueue } from "./tools";

export async function handleQueueBatch(
	batch: MessageBatch,
	env: Env,
): Promise<void> {
	switch (batch.queue) {
		case "relayapi-queue-rescue":
			return consumeQueueRescue(batch, env);
		case "relayapi-media-cleanup-dlq":
		case "relayapi-publish-dlq":
		case "relayapi-email-dlq":
		case "relayapi-refresh-dlq":
		case "relayapi-inbox-dlq":
		case "relayapi-tools-dlq":
		case "relayapi-ads-dlq":
		case "relayapi-sync-dlq":
		case "relayapi-customer-webhooks-dlq":
			return consumeDeadLetterQueue(batch, env);
		case "relayapi-customer-webhooks":
			return consumeCustomerWebhookQueue(
				batch as Parameters<typeof consumeCustomerWebhookQueue>[0],
				env,
			);
		case "relayapi-publish":
			return consumePublishQueue(
				batch as Parameters<typeof consumePublishQueue>[0],
				env,
			);
		case "relayapi-email":
			return consumeEmailQueue(
				batch as Parameters<typeof consumeEmailQueue>[0],
				env,
			);
		case "relayapi-media-cleanup":
			return consumeMediaCleanupQueue(
				batch as Parameters<typeof consumeMediaCleanupQueue>[0],
				env,
			);
		case "relayapi-refresh":
			return consumeTokenRefreshQueue(
				batch as Parameters<typeof consumeTokenRefreshQueue>[0],
				env,
			);
		case "relayapi-inbox":
			return consumeInboxQueue(
				batch as Parameters<typeof consumeInboxQueue>[0],
				env,
			);
		case "relayapi-tools":
			return consumeToolsQueue(
				batch as Parameters<typeof consumeToolsQueue>[0],
				env,
			);
		case "relayapi-ads":
			return consumeAdsQueue(
				batch as Parameters<typeof consumeAdsQueue>[0],
				env,
			);
		case "relayapi-sync":
			return consumeSyncQueue(
				batch as Parameters<typeof consumeSyncQueue>[0],
				env,
			);
		default:
			throw new Error(`No queue consumer registered for ${batch.queue}`);
	}
}
