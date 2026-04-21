// apps/api/src/services/automations/nodes/goto.ts
//
// Graph teleport. The goto node has no output ports (spec §5.2); instead the
// handler signals the runner with a reserved `_goto` port carrying the
// target node_key in its payload. The runner short-circuits normal edge
// resolution and jumps straight to that node.
import type { HandlerResult, NodeHandler } from "../types";

type GotoConfig = { target_node_key: string };

export const gotoHandler: NodeHandler<GotoConfig> = {
	kind: "goto",
	async handle(node): Promise<HandlerResult> {
		const target = node.config?.target_node_key;
		if (!target) {
			return {
				result: "fail",
				error: new Error("goto node missing target_node_key"),
			};
		}
		return {
			result: "advance",
			via_port: "_goto",
			payload: { target_node_key: target },
		};
	},
};
