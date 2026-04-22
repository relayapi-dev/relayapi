// apps/api/src/services/automations/nodes/start-automation.ts
//
// Enrolls the current contact into a *different* automation and advances the
// current run. Non-blocking: the spawned run is executed by the runner loop
// invoked synchronously inside enrollContact, but we don't wait on its
// completion state before taking the `next` port on the current run.

import { enrollContact } from "../runner";
import type { NodeHandler } from "../types";

type StartAutomationConfig = {
	target_automation_id: string;
	pass_context?: boolean;
	entrypoint_id?: string;
};

export const startAutomationHandler: NodeHandler<StartAutomationConfig> = {
	kind: "start_automation",
	async handle(node, ctx) {
		const cfg = (node.config ?? {}) as StartAutomationConfig;
		if (!cfg.target_automation_id) {
			return {
				result: "fail",
				error: new Error("start_automation missing target_automation_id"),
			};
		}
		const db = ctx.db;
		if (!db) {
			return {
				result: "fail",
				error: new Error("start_automation: db binding missing in ctx"),
			};
		}
		try {
			const { runId: spawnedRunId } = await enrollContact(db, {
				automationId: cfg.target_automation_id,
				organizationId: ctx.organizationId,
				contactId: ctx.contactId,
				conversationId: ctx.conversationId,
				channel: ctx.channel,
				entrypointId: cfg.entrypoint_id ?? null,
				bindingId: null,
				contextOverrides: cfg.pass_context ? ctx.context : undefined,
				env: ctx.env,
			});
			return {
				result: "advance",
				via_port: "next",
				payload: { spawned_run_id: spawnedRunId },
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				result: "fail",
				error: new Error(`start_automation failed: ${msg}`),
			};
		}
	},
};
