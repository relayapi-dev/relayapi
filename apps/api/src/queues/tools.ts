import { completeToolJob, failToolJob } from "../services/tool-jobs";
import { callDownloaderService } from "../services/tool-service";
import type { Env } from "../types";

interface ToolJobMessage {
	type: string;
	job_id: string;
	org_id: string;
	endpoint: string;
	payload: Record<string, unknown>;
}

export async function consumeToolsQueue(
	batch: MessageBatch<ToolJobMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;

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
				message.ack();
			} else {
				const delaySeconds = 2 ** message.attempts;
				console.log(
					`[Tools] Retrying ${body.job_id} in ${delaySeconds}s (attempt ${message.attempts})`,
				);
				message.retry({ delaySeconds });
			}
		}
	}
}
