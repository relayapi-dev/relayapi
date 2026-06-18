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
		case "relayapi-automation":
			return consumeAutomationQueue(
				batch as Parameters<typeof consumeAutomationQueue>[0],
				env,
			);
		default:
			// Default is the publish queue (PUBLISH_QUEUE binding)
			return consumePublishQueue(
				batch as Parameters<typeof consumePublishQueue>[0],
				env,
			);
	}
}
