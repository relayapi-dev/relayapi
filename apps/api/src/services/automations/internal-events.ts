// apps/api/src/services/automations/internal-events.ts
//
// Helper for emitting internal automation events from action handlers
// (tag_add, field_set) and other internal sources
// (ref-url click tracker, manual tagging in the inbox). These events flow
// through the same `matchAndEnrollOrBinding` pipeline used by inbound
// platform webhooks.
//
// Cycle protection: internal events can trigger automations whose actions
// emit more internal events. We carry a depth counter in the event payload
// (`_event_depth`) and short-circuit once the recursion exceeds a sensible
// bound so a misconfigured "tag_applied -> tag_add" automation can't melt
// the server.

import type { Database } from "@relayapi/db";
import { matchAndEnrollOrBinding } from "./binding-router";
import type { InboundEvent } from "./trigger-matcher";
import type { RunContext } from "./types";

const MAX_EVENT_DEPTH = 5;

/**
 * Resolve the account that admitted the current run. Internal events must
 * preserve this value so account-scoped listeners match and any child run
 * keeps outbound delivery pinned to the same connected account.
 */
export function resolveTriggeringSocialAccountId(
	ctx: Pick<RunContext, "context" | "env">,
): string | null {
	const fromEnv = ctx.env.socialAccountId;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;

	const persisted = ctx.context._triggering_social_account_id;
	if (typeof persisted === "string" && persisted.length > 0) return persisted;

	const triggerEvent = ctx.context.triggerEvent as
		| { socialAccountId?: unknown }
		| undefined;
	return typeof triggerEvent?.socialAccountId === "string" &&
		triggerEvent.socialAccountId.length > 0
		? triggerEvent.socialAccountId
		: null;
}

/**
 * Enrolls automations that listen for an internal event (tag_applied,
 * field_changed, etc.) The event never flows through the inbox event
 * processor — it's constructed by whichever internal surface mutated the
 * contact state.
 *
 * Failures never throw — this is always called from a "best-effort, don't
 * break the primary mutation" code path.
 */
export async function emitInternalEvent(
	db: Database,
	event: InboundEvent,
	env: Record<string, unknown>,
): Promise<void> {
	try {
		// Extract + bump depth so cycles are capped quickly.
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const currentDepth =
			typeof payload._event_depth === "number" ? payload._event_depth : 0;
		if (currentDepth >= MAX_EVENT_DEPTH) {
			console.warn(
				`[automation internal-events] depth ${currentDepth} >= ${MAX_EVENT_DEPTH}; dropping ${event.kind}`,
			);
			return;
		}

		const nextEvent: InboundEvent = {
			...event,
			payload: {
				...payload,
				_event_depth: currentDepth + 1,
			},
		};

		await matchAndEnrollOrBinding(db, nextEvent, env);
	} catch (err) {
		console.error(
			`[automation internal-events] dispatch failed for ${event.kind}:`,
			err,
		);
	}
}
