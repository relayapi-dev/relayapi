import "./lib/safe-console";
import { WorkerEntrypoint } from "cloudflare:workers";
import app from "./app";
import { RealtimeDO } from "./durable-objects/post-updates";
import { MediaProcessorContainer } from "./durable-objects/media-processor";
import {
	assertRuntimeOpenForInternalRpc,
	createControlledWorker,
} from "./lib/runtime-controls";
import { handleQueueBatch } from "./queues";
import { handleScheduled } from "./scheduled";
import {
	type InternalEmailIntent,
	stageInternalEmailIntent,
} from "./services/email-intents";
import type { Env } from "./types";
import { MediaProcessingWorkflow } from "./workflows/media-processing";

export default createControlledWorker({
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	queue: (batch, env) => handleQueueBatch(batch, env),
	scheduled: (event, env, ctx) => handleScheduled(event, env, ctx),
});

/**
 * Private dashboard-to-API RPC boundary. It accepts domain intents only; the
 * API resolves recipients and renders/encrypts the provider envelope.
 */
export class EmailIntentEntrypoint extends WorkerEntrypoint<Env> {
	async stageEmailIntent(intent: InternalEmailIntent) {
		await assertRuntimeOpenForInternalRpc(this.env);
		return stageInternalEmailIntent(this.env, intent);
	}
}

export { MediaProcessingWorkflow, MediaProcessorContainer, RealtimeDO };
