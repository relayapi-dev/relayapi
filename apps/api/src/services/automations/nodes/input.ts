// apps/api/src/services/automations/nodes/input.ts
//
// Input capture node. Parks the run in `wait_input` state with an optional
// `timeout_at`. Validation, retry handling, and port resolution (captured /
// invalid / skip) happen on the inbound-message resume path in
// `input-resume.ts`; the `timeout` port is driven by the scheduler's
// `input_timeout` job (see scheduler.ts).
import type { NodeHandler } from "../types";

type InputConfig = {
	field: string; // where to store the captured value in ctx.context
	input_type?: "text" | "email" | "phone" | "number" | "choice" | "file";
	choices?: Array<{ value: string; label: string; match?: string[] }>;
	validation?: { pattern?: string; min?: number; max?: number };
	timeout_min?: number; // if set, runs will timeout via `timeout` port after this many minutes
	max_retries?: number; // on invalid input, re-prompt up to N times before `invalid` port
	skip_allowed?: boolean; // if true, "skip" keyword routes via `skip` port
};

export const inputHandler: NodeHandler<InputConfig> = {
	kind: "input",
	async handle(node, ctx) {
		const cfg = node.config ?? ({} as InputConfig);
		const timeoutMin = cfg.timeout_min;
		const timeout_at = timeoutMin
			? new Date(ctx.now.getTime() + timeoutMin * 60_000)
			: undefined;
		return {
			result: "wait_input",
			timeout_at,
			payload: { input_config: cfg },
		};
	},
};
