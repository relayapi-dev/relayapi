import { claimToolJob, executeClaimedToolJob } from "../services/tool-jobs";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

interface ToolJobMessage {
	type: "tool_job";
	job_id: string;
	org_id: string;
}

export async function consumeToolsQueue(
	batch: MessageBatch<ToolJobMessage>,
	env: Env,
): Promise<void> {
	// A tool call can take 60 seconds. Isolate per-message decisions so one
	// provider timeout neither serializes nor acknowledges another job.
	const results = await Promise.allSettled(
		batch.messages.map((message) => handleMessage(message, env)),
	);
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const message = batch.messages[index];
			if (!message) continue;
			console.error("[tools] handler escaped without a terminal decision", {
				event: "tool_job_handler_escape",
				messageId: message.id,
				error: result.reason,
			});
			message.retry({
				delaySeconds: Math.min(2 ** Math.max(message.attempts, 1), 900),
			});
		}
	}
}

function isToolJobMessage(value: unknown): value is ToolJobMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Partial<ToolJobMessage>;
	return (
		body.type === "tool_job" &&
		typeof body.job_id === "string" &&
		body.job_id.length > 0 &&
		typeof body.org_id === "string" &&
		body.org_id.length > 0 &&
		Object.keys(body).every((key) => ["type", "job_id", "org_id"].includes(key))
	);
}

async function handleMessage(
	message: Message<ToolJobMessage>,
	env: Env,
): Promise<void> {
	const body: unknown = message.body;
	if (!isToolJobMessage(body)) {
		await recordQueueFailure(
			env,
			"relayapi-tools",
			message,
			"permanent_input",
			"Malformed or unsupported tools queue message",
		);
		message.ack();
		return;
	}

	const claim = await claimToolJob(env, body.job_id, body.org_id);
	if (!claim) {
		// Duplicate, stale, terminal, or not-yet-due hints are safe to discard;
		// PostgreSQL plus the every-minute dispatcher owns recovery.
		message.ack();
		return;
	}

	const result = await executeClaimedToolJob(env, claim);
	if (result.delivery === "retry") {
		message.retry({ delaySeconds: result.delaySeconds });
	} else {
		message.ack();
	}
}
