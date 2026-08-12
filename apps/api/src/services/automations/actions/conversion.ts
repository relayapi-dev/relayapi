// apps/api/src/services/automations/actions/conversion.ts
//
// log_conversion_event persists one conversion fact/outbox row. A best-effort
// fast path dispatches it now; the every-minute reconciler owns recovery.

import { automationConversionEvents } from "@relayapi/db";
import type { Action } from "../../../schemas/automation-actions";
import { processAutomationConversionDispatch } from "../../automation-conversion-dispatch";
import { resolveTriggeringSocialAccountId } from "../internal-events";
import { applyMergeTags } from "../merge-tags";
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
	const triggerEvent = ctx.context.triggerEvent as
		| { payload?: { _event_depth?: number } }
		| undefined;
	const eventDepth = triggerEvent?.payload?._event_depth ?? 0;
	const socialAccountId = resolveTriggeringSocialAccountId(ctx);

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
			channel: ctx.channel,
			socialAccountId,
			conversationId: ctx.conversationId,
			eventDepth,
			metadata: { action_id: action.id },
		})
		.onConflictDoNothing({ target: automationConversionEvents.occurrenceId });

	try {
		await processAutomationConversionDispatch(ctx.db, ctx.env, {
			occurrenceId,
			limit: 1,
		});
	} catch {
		// The committed conversion row is the authority. The every-minute
		// dispatcher will reclaim it if the fast-path handoff is unavailable.
	}
};

export const conversionHandlers: ActionRegistry = {
	log_conversion_event: logConversionEvent,
};
