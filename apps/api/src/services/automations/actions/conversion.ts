// apps/api/src/services/automations/actions/conversion.ts
//
// log_conversion_event persists an immutable conversion fact before emitting
// the corresponding internal trigger event.

import { automationConversionEvents } from "@relayapi/db";
import type { Action } from "../../../schemas/automation-actions";
import {
	emitInternalEvent,
	resolveTriggeringSocialAccountId,
} from "../internal-events";
import { applyMergeTags } from "../merge-tags";
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
	const mergeContext = {
		contact:
			(ctx.context.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context,
	};
	const eventName = applyMergeTags(action.event_name, mergeContext).trim();
	if (!eventName)
		throw new Error("log_conversion_event: event_name is required");
	const value = action.value
		? applyMergeTags(action.value, mergeContext).trim()
		: null;
	const currency = action.currency?.trim().toUpperCase() || null;
	const occurrenceId =
		ctx.effectIdempotencyKeyFor?.(`conversion:${action.id}`) ??
		`${ctx.runId}:${action.id}`;

	await ctx.db
		.insert(automationConversionEvents)
		.values({
			organizationId: ctx.organizationId,
			scopeKey: ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org",
			automationId: ctx.automationId,
			runId: ctx.runId,
			contactId: ctx.contactId,
			occurrenceId,
			eventName,
			value,
			currency,
			metadata: { action_id: action.id },
		})
		.onConflictDoNothing({ target: automationConversionEvents.occurrenceId });

	const triggerEvent = ctx.context.triggerEvent as
		| { payload?: { _event_depth?: number } }
		| undefined;
	const event: InboundEvent = {
		kind: "conversion_event",
		channel: ctx.channel as InboundEvent["channel"],
		organizationId: ctx.organizationId,
		socialAccountId: resolveTriggeringSocialAccountId(ctx),
		contactId: ctx.contactId,
		conversationId: ctx.conversationId,
		eventName,
		payload: {
			value,
			currency,
			source: "automation",
			automation_id: ctx.automationId,
			run_id: ctx.runId,
			action_id: action.id,
			_event_depth: triggerEvent?.payload?._event_depth ?? 0,
		},
	};
	await emitInternalEvent(ctx.db, event, ctx.env);
};

export const conversionHandlers: ActionRegistry = {
	log_conversion_event: logConversionEvent,
};
