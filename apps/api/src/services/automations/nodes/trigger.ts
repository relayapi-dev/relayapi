import type { NodeHandler } from "../types";

/** The virtual root node. Advances straight to whatever the trigger edges point at. */
export const triggerHandler: NodeHandler = async () => ({ kind: "next" });
