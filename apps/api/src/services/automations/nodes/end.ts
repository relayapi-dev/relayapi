import type { NodeHandler } from "../types";

export const endHandler: NodeHandler = async (ctx) => ({
	kind: "complete",
	reason: (ctx.node.config.reason as string | undefined) ?? "end_node",
});
