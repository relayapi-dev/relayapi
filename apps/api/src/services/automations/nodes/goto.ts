import type { NodeHandler } from "../types";

export const gotoHandler: NodeHandler = async (ctx) => {
	const target = ctx.node.config.target_node_key as string | undefined;
	if (!target) {
		return { kind: "fail", error: "goto node missing target_node_key" };
	}
	return { kind: "goto", target_node_key: target };
};
