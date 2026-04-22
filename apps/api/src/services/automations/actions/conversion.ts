// apps/api/src/services/automations/actions/conversion.ts
//
// log_conversion_event — v1 placeholder. There is no dedicated
// `conversion_events` table in the current schema (only an `objective` enum
// value and aggregated `conversions` counters on posts). Until a follow-up
// migration introduces one, this handler just logs to stderr so operators
// can observe that the action fired without blowing up the automation run.
//
// Even without a persistence layer we still emit an internal
// `conversion_event` so entrypoints listening for conversions (e.g. a
// "purchase → send thank-you DM" flow) can fire. A future persistence
// layer will write the row before dispatching the event.

import type { Action } from "../../../schemas/automation-actions";
import { emitInternalEvent } from "../internal-events";
import type { InboundEvent } from "../trigger-matcher";
import type { ActionHandler, ActionRegistry } from "./types";

type LogConversionEventAction = Extract<
	Action,
	{ type: "log_conversion_event" }
>;

const logConversionEvent: ActionHandler<LogConversionEventAction> = async (
	action,
	ctx,
) => {
	// TODO(v1.1): persist to a real conversion_events table with (org, contact,
	// automation_id, run_id, event_name, value, currency, created_at).
	console.info(
		"[automation log_conversion_event]",
		JSON.stringify({
			organization_id: ctx.organizationId,
			automation_id: ctx.automationId,
			run_id: ctx.runId,
			contact_id: ctx.contactId,
			event_name: action.event_name,
			value: action.value,
			currency: action.currency,
		}),
	);

	const triggerEvent = (ctx.context as Record<string, unknown>)?.triggerEvent as
		| { payload?: { _event_depth?: number } }
		| undefined;
	const depth = triggerEvent?.payload?._event_depth ?? 0;
	const event: InboundEvent = {
		kind: "conversion_event",
		channel: (ctx.channel ?? "instagram") as InboundEvent["channel"],
		organizationId: ctx.organizationId,
		socialAccountId: null,
		contactId: ctx.contactId,
		conversationId: ctx.conversationId ?? null,
		eventName: action.event_name,
		payload: {
			value: action.value,
			currency: action.currency,
			source: "automation",
			automation_id: ctx.automationId,
			run_id: ctx.runId,
			action_id: action.id,
			_event_depth: depth,
		},
	};
	await emitInternalEvent(ctx.db, event, ctx.env);
};

export const conversionHandlers: ActionRegistry = {
	log_conversion_event: logConversionEvent,
};
