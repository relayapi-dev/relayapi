// apps/api/src/services/automations/internal-events.ts
//
// Durable handoff for internal automation events emitted by action handlers.
// Tag/field actions stage one run-owned scheduled job in the same transaction
// as their contact mutation. The scheduler then feeds the event through the
// ordinary trigger matcher. This keeps a transient matcher/Worker failure from
// silently losing a committed contact-state transition.
//
// Cycle protection: internal events can trigger automations whose actions
// emit more internal events. We carry a depth counter in the event payload
// (`_event_depth`) and short-circuit once the recursion exceeds a sensible
// bound so a misconfigured "tag_applied -> tag_add" automation can't melt
// the server.

import { automationScheduledJobs, type Database } from "@relayapi/db";
import { matchAndEnrollOrBinding } from "./binding-router";
import type { InboundEvent } from "./trigger-matcher";
import type { RunContext } from "./types";

export const MAX_INTERNAL_EVENT_DEPTH = 5;

export type DurableInternalEventPayload =
	| {
			version: 1;
			kind: "tag_applied" | "tag_removed";
			action_id: string;
			event_depth: number;
			tag_id: string;
	  }
	| {
			version: 1;
			kind: "field_changed";
			action_id: string;
			event_depth: number;
			field_key: string;
			field_value_before: string | null;
			field_value_after: string | null;
	  };

type InternalEventContext = Pick<
	RunContext,
	| "runId"
	| "automationId"
	| "organizationId"
	| "workspaceId"
	| "now"
	| "effectIdempotencyKeyFor"
>;

function currentInternalEventDepth(event: InboundEvent): number {
	const depth = (event.payload as Record<string, unknown> | null | undefined)
		?._event_depth;
	return typeof depth === "number" && Number.isInteger(depth) && depth >= 0
		? depth
		: 0;
}

export function automationInternalEventOccurrenceId(
	ctx: Pick<InternalEventContext, "runId" | "effectIdempotencyKeyFor">,
	kind: DurableInternalEventPayload["kind"],
	actionId: string,
): string {
	const component = `internal-event:${kind}:${actionId}`;
	const executionOccurrence =
		ctx.effectIdempotencyKeyFor?.(component) ??
		`${ctx.runId}:${encodeURIComponent(component)}`;
	return `internal-event:${executionOccurrence}`;
}

function durablePayloadForEvent(
	event: InboundEvent,
	actionId: string,
): DurableInternalEventPayload | null {
	const nextDepth = currentInternalEventDepth(event) + 1;
	if (nextDepth > MAX_INTERNAL_EVENT_DEPTH) return null;
	const normalizedActionId = actionId.trim();
	if (normalizedActionId.length === 0 || normalizedActionId.length > 512) {
		throw new Error("internal event action_id is invalid");
	}

	if (event.kind === "tag_applied" || event.kind === "tag_removed") {
		const tagId = event.tagId?.trim();
		if (!tagId || tagId.length > 512) {
			throw new Error("internal tag event tag_id is invalid");
		}
		return {
			version: 1,
			kind: event.kind,
			action_id: normalizedActionId,
			event_depth: nextDepth,
			tag_id: tagId,
		};
	}
	if (event.kind === "field_changed") {
		const fieldKey = event.fieldKey?.trim();
		if (!fieldKey || fieldKey.length > 512) {
			throw new Error("internal field event field_key is invalid");
		}
		const before = event.fieldValueBefore;
		const after = event.fieldValueAfter;
		if (
			(before !== null && typeof before !== "string") ||
			(after !== null && typeof after !== "string")
		) {
			throw new Error("internal field event values are invalid");
		}
		return {
			version: 1,
			kind: "field_changed",
			action_id: normalizedActionId,
			event_depth: nextDepth,
			field_key: fieldKey,
			field_value_before: before,
			field_value_after: after,
		};
	}
	throw new Error(`unsupported durable internal event kind: ${event.kind}`);
}

/**
 * Stage a run-owned internal event. Call this from the same transaction that
 * mutates the contact. The occurrence is tied to the exact node execution, so
 * a replay cannot duplicate downstream enrollment.
 */
export async function stageInternalEvent(
	db: Pick<Database, "insert">,
	ctx: InternalEventContext,
	event: InboundEvent,
	actionId: string,
): Promise<boolean> {
	const payload = durablePayloadForEvent(event, actionId);
	if (!payload) return false;

	await db
		.insert(automationScheduledJobs)
		.values({
			occurrenceId: automationInternalEventOccurrenceId(
				ctx,
				payload.kind,
				payload.action_id,
			),
			organizationId: ctx.organizationId,
			scopeKey: ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org",
			runId: ctx.runId,
			jobType: "internal_event",
			automationId: ctx.automationId,
			runAt: ctx.now,
			payload,
		})
		.onConflictDoNothing({ target: automationScheduledJobs.occurrenceId });
	return true;
}

export function parseDurableInternalEventPayload(
	value: unknown,
): DurableInternalEventPayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const payload = value as Record<string, unknown>;
	if (
		payload.version !== 1 ||
		typeof payload.action_id !== "string" ||
		payload.action_id.trim().length === 0 ||
		payload.action_id.length > 512 ||
		typeof payload.event_depth !== "number" ||
		!Number.isInteger(payload.event_depth) ||
		payload.event_depth < 1 ||
		payload.event_depth > MAX_INTERNAL_EVENT_DEPTH
	) {
		return null;
	}
	if (payload.kind === "tag_applied" || payload.kind === "tag_removed") {
		if (
			typeof payload.tag_id !== "string" ||
			payload.tag_id.trim().length === 0 ||
			payload.tag_id.length > 512
		) {
			return null;
		}
		return {
			version: 1,
			kind: payload.kind,
			action_id: payload.action_id,
			event_depth: payload.event_depth,
			tag_id: payload.tag_id,
		};
	}
	if (payload.kind !== "field_changed") return null;
	if (
		typeof payload.field_key !== "string" ||
		payload.field_key.trim().length === 0 ||
		payload.field_key.length > 512 ||
		!("field_value_before" in payload) ||
		!("field_value_after" in payload) ||
		(payload.field_value_before !== null &&
			typeof payload.field_value_before !== "string") ||
		(payload.field_value_after !== null &&
			typeof payload.field_value_after !== "string")
	) {
		return null;
	}
	return {
		version: 1,
		kind: "field_changed",
		action_id: payload.action_id,
		event_depth: payload.event_depth,
		field_key: payload.field_key,
		field_value_before: payload.field_value_before,
		field_value_after: payload.field_value_after,
	};
}

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
 * Legacy immediate helper for non-transactional internal sources. Contact
 * mutation handlers use stageInternalEvent instead.
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
		if (currentDepth >= MAX_INTERNAL_EVENT_DEPTH) {
			console.warn(
				`[automation internal-events] depth ${currentDepth} >= ${MAX_INTERNAL_EVENT_DEPTH}; dropping ${event.kind}`,
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
