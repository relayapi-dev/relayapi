import { advanceEnrollment, resumeFromInput } from "../services/automations/runner";
import type { AutomationQueueMessage } from "../services/automations/types";
import type { Env } from "../types";

export async function consumeAutomationQueue(
	batch: MessageBatch<AutomationQueueMessage>,
	env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		try {
			const body = msg.body;
			switch (body.type) {
				case "advance":
					await advanceEnrollment(env, body.enrollment_id);
					break;
				case "resume_from_input":
					await resumeFromInput(env, body.enrollment_id, body.input_value);
					break;
				case "enroll":
					// Direct enrollment is rare; normally go through trigger-matcher.
					// This path lets `POST /v1/automations/:id/enroll` kick a flow.
					console.warn(
						"automation enqueue via 'enroll' not yet implemented; use trigger-matcher",
					);
					break;
			}
			msg.ack();
		} catch (e) {
			console.error("automation queue error", e);
			msg.retry();
		}
	}
}
