import type { NodeHandler } from "../types";

/**
 * Sends the prompt text, parks the enrollment in 'waiting' state with a
 * `_pending_input_key` marker. When the next inbound message from the contact
 * arrives, `platform-webhooks.ts` routes it to `resumeFromInput()` which
 * captures the value and advances the graph.
 *
 * The captured value validation + retry loop against `no_match` is wired in
 * Phase 8 per input subtype.
 */
export const userInputHandler: NodeHandler = async (ctx) => {
	const saveToField = ctx.node.config.save_to_field as string | undefined;
	if (!saveToField) {
		return { kind: "fail", error: "user_input missing 'save_to_field'" };
	}

	// Send prompt (reuse message_text by delegating).
	// For Phase 2 simplicity we just park — actual prompt send is deferred to
	// the runner which will call messageTextHandler with the prompt before parking.

	const timeoutMin = ctx.node.config.timeout_minutes as number | undefined;
	const patch: Record<string, unknown> = {
		_pending_input_field: saveToField,
		_pending_input_node_key: ctx.node.key,
	};
	if (timeoutMin) {
		patch._pending_input_timeout_at = new Date(
			Date.now() + timeoutMin * 60 * 1000,
		).toISOString();
	}

	return { kind: "wait_for_input", state_patch: patch };
};
