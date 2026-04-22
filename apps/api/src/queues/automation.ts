// apps/api/src/queues/automation.ts
//
// Deprecated queue consumer. The post-rebuild runtime dispatches work via the
// `automation_scheduled_jobs` table (see scheduler.ts) and inline inbox-event
// resumption — no code path currently sends to `AUTOMATION_QUEUE`.
//
// The consumer is kept wired up only so the queue binding in `wrangler.jsonc`
// has a handler. Any stray pre-migration message is ack'd without side
// effects. Remove the binding + this file once the queue drains in production.

import type { Env } from "../types";

export type AutomationQueueMessage = {
	type: string;
	[key: string]: unknown;
};

export async function consumeAutomationQueue(
	batch: MessageBatch<AutomationQueueMessage>,
	_env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		console.warn(
			"[automation-queue] deprecated consumer received message; acking",
			msg.body?.type,
		);
		msg.ack();
	}
}
