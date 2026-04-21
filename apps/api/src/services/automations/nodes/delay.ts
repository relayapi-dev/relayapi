// apps/api/src/services/automations/nodes/delay.ts
//
// Fixed-duration wait. Returns `wait_delay` with an absolute resume_at date.
// Minimum delay is clamped to 1s so we never thrash the scheduler with zero
// or negative intervals.
import type { NodeHandler } from "../types";

type DelayConfig = {
	seconds?: number;
	minutes?: number;
	hours?: number;
	days?: number;
};

export const delayHandler: NodeHandler<DelayConfig> = {
	kind: "delay",
	async handle(node, ctx) {
		const cfg = node.config ?? {};
		const totalMs =
			(cfg.seconds ?? 0) * 1_000 +
			(cfg.minutes ?? 0) * 60_000 +
			(cfg.hours ?? 0) * 3_600_000 +
			(cfg.days ?? 0) * 86_400_000;
		const resume_at = new Date(ctx.now.getTime() + Math.max(totalMs, 1_000));
		return { result: "wait_delay", resume_at };
	},
};
