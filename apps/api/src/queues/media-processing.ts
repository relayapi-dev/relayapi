import {
	exponentialBackoffSeconds,
	QUEUE_DELIVERY_RETRY,
} from "../lib/async-policy";
import type { Env } from "../types";
import type { MediaProcessingWorkflowParams } from "../workflows/media-processing";
import { recordQueueFailure } from "./failures";

export interface MediaProcessingQueueMessage {
	jobId: string;
	generation: number;
}

function isMediaProcessingMessage(
	value: unknown,
): value is MediaProcessingQueueMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.jobId === "string" &&
		body.jobId.startsWith("mproc_") &&
		Number.isSafeInteger(body.generation) &&
		Number(body.generation) >= 0 &&
		Object.keys(body).every((key) => ["jobId", "generation"].includes(key))
	);
}

export async function consumeMediaProcessingQueue(
	batch: MessageBatch<MediaProcessingQueueMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		if (!isMediaProcessingMessage(message.body)) {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Invalid media processing queue payload",
			);
			message.ack();
			continue;
		}
		const body = message.body;
		const instanceId = `${body.jobId}-${body.generation}`;
		try {
			try {
				await env.MEDIA_PROCESSING_WORKFLOW.create({
					id: instanceId,
					params: body satisfies MediaProcessingWorkflowParams,
					retention: {
						successRetention: "7 days",
						errorRetention: "30 days",
					},
				});
			} catch (error) {
				// Queue delivery is at-least-once. A stable generation maps to one
				// Workflow ID, so an already-created instance is a successful handoff.
				const existing = await env.MEDIA_PROCESSING_WORKFLOW.get(instanceId);
				const state = await existing.status();
				if (state.status === "unknown") throw error;
			}
			message.ack();
		} catch {
			message.retry({
				delaySeconds: exponentialBackoffSeconds(
					message.attempts,
					QUEUE_DELIVERY_RETRY,
					`${message.id}:${message.attempts}`,
				),
			});
		}
	}
}
