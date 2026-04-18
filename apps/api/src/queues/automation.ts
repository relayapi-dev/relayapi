import { advanceEnrollment, resumeFromInput } from "../services/automations/runner";
import { enrollDirectly } from "../services/automations/trigger-matcher";
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
					await advanceEnrollment(env, body.enrollment_id, {
						resumeLabel: body.resume_label,
					});
					break;
				case "resume_from_input":
					await resumeFromInput(env, body.enrollment_id, body.input_value);
					break;
				case "enroll": {
					// organization_id needed to scope the enroll. The message producer
					// (currently only the HTTP enroll route) must include it.
					const orgId = (body as { organization_id?: string }).organization_id;
					if (!orgId) {
						console.warn(
							"[automation-queue] 'enroll' message missing organization_id; skipping",
							body,
						);
						break;
					}
					const result = await enrollDirectly(env, {
						organization_id: orgId,
						automation_id: body.automation_id,
						contact_id: body.contact_id,
						payload: body.trigger_payload,
					});
					if (!result.ok) {
						console.warn(
							"[automation-queue] 'enroll' rejected",
							body.automation_id,
							result.reason,
						);
					}
					break;
				}
			}
			msg.ack();
		} catch (e) {
			console.error("automation queue error", e);
			msg.retry();
		}
	}
}
