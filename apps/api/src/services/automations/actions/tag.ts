// apps/api/src/services/automations/actions/tag.ts
//
// tag_add / tag_remove — mutate the `contacts.tags` text[] column for the
// current contact. Tags are identified by name; there's no separate join
// table in the current schema, so "create if missing" collapses to "append
// to array if not already present".
//
// After a successful mutation we emit an internal `tag_applied` /
// `tag_removed` event so entrypoints listening for tag changes fire. Cycle
// protection sits inside `emitInternalEvent` (depth counter in payload).

import { contacts } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import { emitInternalEvent } from "../internal-events";
import type { InboundEvent } from "../trigger-matcher";
import type { ActionHandler, ActionRegistry } from "./types";

type TagAddAction = Extract<Action, { type: "tag_add" }>;
type TagRemoveAction = Extract<Action, { type: "tag_remove" }>;

function internalEventFromCtx(
	ctx: any,
	kind: "tag_applied" | "tag_removed",
	tag: string,
	actionId: string,
	triggerEvent: unknown,
): InboundEvent {
	const depth =
		(triggerEvent as { payload?: { _event_depth?: number } } | undefined)
			?.payload?._event_depth ?? 0;
	return {
		kind,
		channel: (ctx.channel ?? "instagram") as InboundEvent["channel"],
		organizationId: ctx.organizationId,
		socialAccountId: null,
		contactId: ctx.contactId,
		conversationId: ctx.conversationId ?? null,
		tagId: tag,
		payload: {
			source: "automation",
			automation_id: ctx.automationId,
			run_id: ctx.runId,
			action_id: actionId,
			_event_depth: depth,
		},
	};
}

const tagAdd: ActionHandler<TagAddAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("tag_add: db binding missing");
	const tag = action.tag.trim();
	if (!tag) return;

	// Check whether the tag is already on the contact before mutating — if so
	// this is a no-op and we must NOT emit a `tag_applied` event (which would
	// spuriously re-fire listener automations on every repeat call).
	const existing = await db.query.contacts.findFirst({
		where: and(
			eq(contacts.id, ctx.contactId),
			eq(contacts.organizationId, ctx.organizationId),
		),
	});
	const wasPresent = Array.isArray(existing?.tags)
		? (existing!.tags as string[]).includes(tag)
		: false;

	await db
		.update(contacts)
		.set({
			tags: sql`
				CASE
					WHEN ${tag} = ANY(${contacts.tags}) THEN ${contacts.tags}
					ELSE array_append(${contacts.tags}, ${tag})
				END
			`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(contacts.id, ctx.contactId),
				eq(contacts.organizationId, ctx.organizationId),
			),
		);

	if (wasPresent) return;

	// Mirror the DB mutation into `ctx.context.tags` so downstream condition
	// nodes in the SAME run see the fresh tag set. Without this, a
	// tag_add → condition(contact has tag X) → branch(true) flow always
	// takes the false branch because ctx.context was hydrated at enroll time
	// and the runner only re-reads it across run iterations, not within a
	// single handler chain. Fix for Plan 6 Unit RR11 / Task 5 (F6).
	const currentTags = Array.isArray(ctx.context.tags)
		? (ctx.context.tags as string[])
		: [];
	if (!currentTags.includes(tag)) {
		ctx.context.tags = [...currentTags, tag];
	}

	// Best-effort internal event — never fail the primary tag mutation.
	await emitInternalEvent(
		db,
		internalEventFromCtx(
			ctx,
			"tag_applied",
			tag,
			action.id,
			(ctx.context as Record<string, unknown>)?.triggerEvent,
		),
		ctx.env,
	);
};

const tagRemove: ActionHandler<TagRemoveAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("tag_remove: db binding missing");
	const tag = action.tag.trim();
	if (!tag) return;

	// Same no-op guard as tag_add — only emit `tag_removed` if the tag was
	// actually present before the mutation.
	const existing = await db.query.contacts.findFirst({
		where: and(
			eq(contacts.id, ctx.contactId),
			eq(contacts.organizationId, ctx.organizationId),
		),
	});
	const wasPresent = Array.isArray(existing?.tags)
		? (existing!.tags as string[]).includes(tag)
		: false;

	await db
		.update(contacts)
		.set({
			tags: sql`array_remove(${contacts.tags}, ${tag})`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(contacts.id, ctx.contactId),
				eq(contacts.organizationId, ctx.organizationId),
			),
		);

	if (!wasPresent) return;

	// Mirror the removal into ctx.context.tags so later condition nodes in
	// the same run see the contact without the tag. Plan 6 Unit RR11 /
	// Task 5 (F6).
	const currentTags = Array.isArray(ctx.context.tags)
		? (ctx.context.tags as string[])
		: [];
	ctx.context.tags = currentTags.filter((t) => t !== tag);

	await emitInternalEvent(
		db,
		internalEventFromCtx(
			ctx,
			"tag_removed",
			tag,
			action.id,
			(ctx.context as Record<string, unknown>)?.triggerEvent,
		),
		ctx.env,
	);
};

export const tagHandlers: ActionRegistry = {
	tag_add: tagAdd,
	tag_remove: tagRemove,
};
