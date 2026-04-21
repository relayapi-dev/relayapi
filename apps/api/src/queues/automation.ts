// apps/api/src/queues/automation.ts
//
// Queue consumer for the Manychat-parity automation engine. Dispatches queued
// work to the new runtime primitives:
//   - resume_run   → runLoop(runId)    (used by scheduler for wait_delay wake)
//   - enroll       → enrollContact(...) (used by HTTP enroll fallback)
//
// The older advance/resume_from_input shapes from the legacy engine are no
// longer produced — inbox-event-processor now resumes waiting runs inline and
// the scheduler dispatches resume_run jobs directly. This consumer stays wired
// up so any in-flight queue messages from pre-migration deployments don't
// crash the worker, but new producers should prefer the direct calls.

import { createDb } from "@relayapi/db";
import { enrollContact } from "../services/automations/runner";
import { runLoop } from "../services/automations/runner";
import type { Env } from "../types";

export type AutomationQueueMessage =
	| {
			type: "resume_run";
			run_id: string;
	  }
	| {
			type: "enroll";
			organization_id: string;
			automation_id: string;
			contact_id: string;
			conversation_id?: string | null;
			channel: string;
			entrypoint_id?: string | null;
			context_overrides?: Record<string, unknown>;
	  };

export async function consumeAutomationQueue(
	batch: MessageBatch<AutomationQueueMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const envAsRecord = env as unknown as Record<string, unknown>;

	for (const msg of batch.messages) {
		try {
			const body = msg.body;
			switch (body.type) {
				case "resume_run": {
					await runLoop(db, body.run_id, envAsRecord);
					break;
				}
				case "enroll": {
					await enrollContact(db, {
						automationId: body.automation_id,
						organizationId: body.organization_id,
						contactId: body.contact_id,
						conversationId: body.conversation_id ?? null,
						channel: body.channel,
						entrypointId: body.entrypoint_id ?? null,
						bindingId: null,
						contextOverrides: body.context_overrides,
						env: envAsRecord,
					});
					break;
				}
				default: {
					// Unknown message types (including legacy 'advance' /
					// 'resume_from_input') are ack'd so they don't block the queue.
					console.warn(
						"[automation-queue] unknown message type; acking and skipping",
						body,
					);
				}
			}
			msg.ack();
		} catch (e) {
			console.error("automation queue error", e);
			msg.retry();
		}
	}
}
