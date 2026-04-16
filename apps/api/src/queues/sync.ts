import type { AnalyticsQueueMessage } from "../services/analytics-refresh";
import {
	refreshExternalPostMetricsBatch,
	refreshInternalPostMetrics,
} from "../services/analytics-refresh";
import {
	refreshExternalPostMetrics,
	syncExternalPosts,
} from "../services/external-post-sync/sync";
import {
	RateLimitError,
	type SyncQueueMessage,
} from "../services/external-post-sync/types";
import type { Env } from "../types";

type SyncMessage = SyncQueueMessage | AnalyticsQueueMessage;

export async function consumeSyncQueue(
	batch: MessageBatch<SyncMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;

		try {
			switch (body.type) {
				case "sync_posts":
					await syncExternalPosts(env, body);
					break;
				case "refresh_metrics":
					await refreshExternalPostMetrics(env, body);
					break;
				case "refresh_internal_metrics":
					await refreshInternalPostMetrics(env, body);
					break;
				case "refresh_external_metrics_batch":
					await refreshExternalPostMetricsBatch(env, body);
					break;
				default:
					console.warn(
						`[Sync] Unknown message type: ${(body as { type: string }).type}`,
					);
			}
			message.ack();
		} catch (err) {
			console.error(
				`[Sync] Error processing ${body.type} (attempt ${message.attempts}):`,
				err instanceof Error ? err.message : err,
			);
			if (err instanceof Error && err.stack) {
				console.error(`[Sync] Stack:`, err.stack);
			}
			console.error(`[Sync] Message body:`, JSON.stringify(body));

			if (err instanceof RateLimitError) {
				const delaySec = Math.max(
					Math.ceil((err.resetAt.getTime() - Date.now()) / 1000),
					30,
				);
				message.retry({ delaySeconds: Math.min(delaySec, 900) });
			} else if (message.attempts < 3) {
				const delaySeconds = 2 ** message.attempts;
				message.retry({ delaySeconds });
			} else {
				console.error(`[Sync] Max retries exceeded for ${body.type}, dropping`);
				message.ack();
			}
		}
	}
}
