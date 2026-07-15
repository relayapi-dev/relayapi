import { completeToolJob, failToolJob } from "../services/tool-jobs";
import { callDownloaderService } from "../services/tool-service";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

interface ToolJobMessage {
	type: "tool_download" | "tool_transcript";
	job_id: string;
	org_id: string;
	endpoint: string;
	payload: Record<string, unknown>;
}

export async function consumeToolsQueue(
	batch: MessageBatch<ToolJobMessage>,
	env: Env,
): Promise<void> {
	// Process the batch concurrently — each message awaits a slow (up to 60s)
	// downloader call, so a serial loop would stack those latencies and delay the
	// last job in the batch by minutes. Per-message ack/retry stays isolated.
	const results = await Promise.allSettled(
		batch.messages.map((message) => handleMessage(message, env)),
	);
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const message = batch.messages[index];
			if (!message) continue;
			console.error("[Tools] handler escaped without a terminal decision", {
				messageId: message.id,
				error:
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
			});
			message.retry({ delaySeconds: Math.min(2 ** message.attempts, 900) });
		}
	}
}

function isToolJobMessage(value: unknown): value is ToolJobMessage {
	if (!value || typeof value !== "object") return false;
	const body = value as Partial<ToolJobMessage>;
	return (
		(body.type === "tool_download" || body.type === "tool_transcript") &&
		typeof body.job_id === "string" &&
		body.job_id.length > 0 &&
		typeof body.org_id === "string" &&
		body.org_id.length > 0 &&
		typeof body.endpoint === "string" &&
		body.endpoint.length > 0 &&
		body.payload !== null &&
		typeof body.payload === "object" &&
		!Array.isArray(body.payload)
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

	try {
		// Queue consumers get 15 minutes — use 60s timeout for the VPS call
		const result = await callDownloaderService(
			env,
			body.endpoint,
			body.payload,
			60_000,
		);

		if (result.ok) {
			await completeToolJob(env.KV, body.job_id, result.data);
		} else {
			await failToolJob(env.KV, body.job_id, result.error);
		}
		message.ack();
	} catch (err) {
		if (message.attempts >= 3) {
			await failToolJob(
				env.KV,
				body.job_id,
				`Failed after ${message.attempts} attempts: ${err}`,
			);
			// Preserve exhausted infrastructure work in the configured DLQ. The KV
			// job result is only a user-facing projection, not the recovery ledger.
			message.retry({ delaySeconds: 60 });
		} else {
			const delaySeconds = 2 ** message.attempts;
			console.log(
				`[Tools] Retrying ${body.job_id} in ${delaySeconds}s (attempt ${message.attempts})`,
			);
			message.retry({ delaySeconds });
		}
	}
}
