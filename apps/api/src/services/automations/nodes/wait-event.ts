import type { NodeHandler } from "../types";

type WaitEventConfig = {
	event_kinds?: string[];
	timeout_min?: number;
};

export const waitEventHandler: NodeHandler<WaitEventConfig> = {
	kind: "wait_event",
	async handle(node, ctx) {
		const eventKinds = [...new Set(node.config?.event_kinds ?? [])];
		if (eventKinds.length === 0) {
			return {
				result: "fail",
				error: new Error("wait_event requires at least one event_kind"),
			};
		}
		const timeoutMin = node.config?.timeout_min;
		return {
			result: "wait_event",
			event_kinds: eventKinds,
			timeout_at:
				timeoutMin && timeoutMin > 0
					? new Date(ctx.now.getTime() + timeoutMin * 60_000)
					: undefined,
			payload: { event_kinds: eventKinds },
		};
	},
};
