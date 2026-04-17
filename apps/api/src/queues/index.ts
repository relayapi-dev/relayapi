import type { Env } from "../types";
import { consumeAdsQueue } from "./ads";
import { consumeAutomationQueue } from "./automation";
import { consumeEmailQueue } from "./email";
import { consumeInboxQueue } from "./inbox";
import { consumeMediaCleanupQueue } from "./media-cleanup";
import { consumePublishQueue } from "./publish";
import { consumeSyncQueue } from "./sync";
import { consumeTokenRefreshQueue } from "./token-refresh";
import { consumeToolsQueue } from "./tools";

export async function handleQueueBatch(
	batch: MessageBatch,
	env: Env,
): Promise<void> {
	switch (batch.queue) {
		case "relayapi-email":
			return consumeEmailQueue(batch as MessageBatch<any>, env);
		case "relayapi-media-cleanup":
			return consumeMediaCleanupQueue(batch as MessageBatch<any>, env);
		case "relayapi-refresh":
			return consumeTokenRefreshQueue(batch as MessageBatch<any>, env);
		case "relayapi-inbox":
			return consumeInboxQueue(batch as MessageBatch<any>, env);
		case "relayapi-tools":
			return consumeToolsQueue(batch as MessageBatch<any>, env);
		case "relayapi-ads":
			return consumeAdsQueue(batch as MessageBatch<any>, env);
		case "relayapi-sync":
			return consumeSyncQueue(batch as MessageBatch<any>, env);
		case "relayapi-automation":
			return consumeAutomationQueue(batch as MessageBatch<any>, env);
		default:
			// Default is the publish queue (PUBLISH_QUEUE binding)
			return consumePublishQueue(batch as MessageBatch<any>, env);
	}
}
