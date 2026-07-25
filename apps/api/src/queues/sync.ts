import type { AnalyticsQueueMessage } from "../services/analytics-refresh";
import {
	refreshExternalPostMetricsBatch,
	refreshInternalPostMetrics,
} from "../services/analytics-refresh";
import { processExternalPostPreview } from "../services/external-post-sync/previews";
import {
	refreshExternalPostMetrics,
	syncExternalPosts,
} from "../services/external-post-sync/sync";
import {
	RateLimitError,
	type SyncQueueMessage,
} from "../services/external-post-sync/types";
import type { Env } from "../types";
import { syncAutomationBinding } from "../services/automations/binding-sync";
import { recordQueueFailure } from "./failures";

type SyncMessage = SyncQueueMessage | AnalyticsQueueMessage;

export async function consumeSyncQueue(
	batch: MessageBatch<SyncMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body as SyncMessage | null;

		try {
			switch (body?.type) {
				case "sync_posts":
					await syncExternalPosts(env, body);
					break;
				case "refresh_metrics":
					await refreshExternalPostMetrics(env, body);
					break;
				case "generate_external_preview":
					await processExternalPostPreview(env, body);
					break;
				case "sync_automation_binding":
					await syncAutomationBinding(env, body);
					break;
				case "refresh_internal_metrics":
					await refreshInternalPostMetrics(env, body);
					break;
				case "refresh_external_metrics_batch":
					await refreshExternalPostMetricsBatch(env, body);
					break;
				default:
					console.warn(
						`[Sync] Unknown message type: ${String(
							(message.body as { type?: unknown } | null)?.type,
						)}`,
					);
					await recordQueueFailure(
						env,
						batch.queue,
						message,
						"permanent_input",
						"Malformed or unsupported sync queue message",
					);
			}
			message.ack();
		} catch (err) {
			console.error(
				`[Sync] Error processing ${String(body?.type)} (attempt ${message.attempts}):`,
				err instanceof Error ? err.message : err,
			);
			if (err instanceof Error && err.stack) {
				console.error(`[Sync] Stack:`, err.stack);
			}
			console.error("[Sync] Message failed", { messageId: message.id });

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
				console.error(
					`[Sync] Max retries exceeded for ${String(body?.type)}; sending to DLQ`,
				);
				message.retry({ delaySeconds: 60 });
			}
		}
	}
}
