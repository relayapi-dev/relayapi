// apps/api/src/services/automations/nodes/end.ts
//
// Terminal node. Uses config.reason when provided, otherwise "completed".
import type { NodeHandler } from "../types";

type EndConfig = { reason?: string };

export const endHandler: NodeHandler<EndConfig> = {
	kind: "end",
	async handle(node) {
		const reason =
			typeof node.config?.reason === "string" ? node.config.reason.trim() : "";
		return {
			result: "end",
			exit_reason: reason || "completed",
		};
	},
};
