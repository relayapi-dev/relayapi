// apps/api/src/services/automations/actions/conversion.ts
//
// log_conversion_event — v1 placeholder. There is no dedicated
// `conversion_events` table in the current schema (only an `objective` enum
// value and aggregated `conversions` counters on posts). Until a follow-up
// migration introduces one, this handler just logs to stderr so operators
// can observe that the action fired without blowing up the automation run.

import type { Action } from "../../../schemas/automation-actions";
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
};

export const conversionHandlers: ActionRegistry = {
	log_conversion_event: logConversionEvent,
};
