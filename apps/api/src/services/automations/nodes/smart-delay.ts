import type { NodeHandler } from "../types";

export const smartDelayHandler: NodeHandler = async (ctx) => {
	const minutes = ctx.node.config.duration_minutes as number | undefined;
	if (typeof minutes !== "number" || minutes < 1) {
		return {
			kind: "fail",
			error: "smart_delay missing or invalid duration_minutes",
		};
	}
	// Quiet-hours respect deferred to Phase 8 hardening.
	const nextRunAt = new Date(Date.now() + minutes * 60 * 1000);
	return { kind: "wait", next_run_at: nextRunAt };
};
