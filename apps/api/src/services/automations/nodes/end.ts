// apps/api/src/services/automations/nodes/end.ts
//
// Terminal node. Always ends the run with exit_reason = "completed".
import type { NodeHandler } from "../types";

export const endHandler: NodeHandler = {
	kind: "end",
	async handle() {
		return { result: "end", exit_reason: "completed" };
	},
};
