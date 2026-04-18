import app from "./app";
import { RealtimeDO } from "./durable-objects/post-updates";
import { handleQueueBatch } from "./queues";
import { handleScheduled } from "./scheduled";
import type { Env } from "./types";

export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch, env: Env) {
		return handleQueueBatch(batch, env);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		return handleScheduled(event, env, ctx);
	},
};

export { RealtimeDO };
