// apps/api/src/services/automations/nodes/action-group.ts
//
// Runs a list of side-effect actions (tag_add, field_set, subscribe_list,
// notify_admin, webhook_out, ...) sequentially. Each action declares an
// `on_error` policy ("abort" by default, or "continue") that decides what
// happens after a failure.
//
// Output routing (see ports.ts):
//   - `next`  — all actions completed (even if some had on_error=continue
//               failures — those are recorded in step_run payload but don't
//               affect routing).
//   - `error` — an action with on_error="abort" threw; subsequent actions
//               are not called.

import type { Action } from "../../../schemas/automation-actions";
import { dispatchAction } from "../actions";
import type { NodeHandler } from "../types";

type ActionGroupConfig = {
	actions: Action[];
};

export const actionGroupHandler: NodeHandler<ActionGroupConfig> = {
	kind: "action_group",
	async handle(node, ctx) {
		const cfg = (node.config ?? {}) as ActionGroupConfig;
		const actions = Array.isArray(cfg.actions) ? cfg.actions : [];
		const results: Array<{ id: string; ok: boolean; error?: string }> = [];
		let abortedByError = false;

		for (const action of actions) {
			try {
				await dispatchAction(action, ctx);
				results.push({ id: action.id, ok: true });
			} catch (err: unknown) {
				const message =
					err instanceof Error ? err.message : String(err);
				results.push({ id: action.id, ok: false, error: message });
				const onError = action.on_error ?? "abort";
				if (onError === "abort") {
					abortedByError = true;
					break;
				}
				// on_error === "continue": record failure and move on.
			}
		}

		return {
			result: "advance",
			via_port: abortedByError ? "error" : "next",
			payload: { action_results: results },
		};
	},
};
