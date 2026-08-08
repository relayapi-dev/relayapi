// apps/api/src/services/automations/actions/tag.ts
//
// tag_add / tag_remove — mutate the `contacts.tags` text[] column for the
// current contact. Tags are identified by name; there's no separate join
// table in the current schema, so "create if missing" collapses to "append
// to array if not already present".
//
// The contact mutation and its internal `tag_applied` / `tag_removed` job are
// committed together. Cycle protection is encoded in the staged event depth.

import { contacts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import {
	resolveTriggeringSocialAccountId,
	stageInternalEvent,
} from "../internal-events";
import type { InboundEvent } from "../trigger-matcher";
import type { RunContext } from "../types";
import type { ActionHandler, ActionRegistry } from "./types";

type TagAddAction = Extract<Action, { type: "tag_add" }>;
type TagRemoveAction = Extract<Action, { type: "tag_remove" }>;

function internalEventFromCtx(
	ctx: RunContext,
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
		socialAccountId: resolveTriggeringSocialAccountId(ctx),
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
	const scopeKey = ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org";
	const event = internalEventFromCtx(
		ctx,
		"tag_applied",
		tag,
		action.id,
		(ctx.context as Record<string, unknown>)?.triggerEvent,
	);
	const nextTags = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ tags: contacts.tags })
			.from(contacts)
			.where(
				and(
					eq(contacts.id, ctx.contactId),
					eq(contacts.organizationId, ctx.organizationId),
					eq(contacts.scopeKey, scopeKey),
				),
			)
			.for("update")
			.limit(1);
		if (!existing) throw new Error("tag_add: contact not found in run scope");
		const tags = Array.isArray(existing.tags) ? existing.tags : [];
		if (tags.includes(tag)) return null;
		const updatedTags = [...tags, tag];
		await tx
			.update(contacts)
			.set({ tags: updatedTags, updatedAt: ctx.now })
			.where(
				and(
					eq(contacts.id, ctx.contactId),
					eq(contacts.organizationId, ctx.organizationId),
					eq(contacts.scopeKey, scopeKey),
				),
			);
		await stageInternalEvent(tx, ctx, event, action.id);
		return updatedTags;
	});
	if (!nextTags) return;

	// Mirror the DB mutation into `ctx.context.tags` so downstream condition
	// nodes in the SAME run see the fresh tag set. Without this, a
	// tag_add → condition(contact has tag X) → branch(true) flow always
	// takes the false branch because ctx.context was hydrated at enroll time
	// and the runner only re-reads it across run iterations, not within a
	// single handler chain. Fix for Plan 6 Unit RR11 / Task 5 (F6).
	ctx.context.tags = nextTags;
};

const tagRemove: ActionHandler<TagRemoveAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("tag_remove: db binding missing");
	const tag = action.tag.trim();
	if (!tag) return;
	const scopeKey = ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org";
	const event = internalEventFromCtx(
		ctx,
		"tag_removed",
		tag,
		action.id,
		(ctx.context as Record<string, unknown>)?.triggerEvent,
	);
	const nextTags = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ tags: contacts.tags })
			.from(contacts)
			.where(
				and(
					eq(contacts.id, ctx.contactId),
					eq(contacts.organizationId, ctx.organizationId),
					eq(contacts.scopeKey, scopeKey),
				),
			)
			.for("update")
			.limit(1);
		if (!existing)
			throw new Error("tag_remove: contact not found in run scope");
		const tags = Array.isArray(existing.tags) ? existing.tags : [];
		if (!tags.includes(tag)) return null;
		const updatedTags = tags.filter((current) => current !== tag);
		await tx
			.update(contacts)
			.set({ tags: updatedTags, updatedAt: ctx.now })
			.where(
				and(
					eq(contacts.id, ctx.contactId),
					eq(contacts.organizationId, ctx.organizationId),
					eq(contacts.scopeKey, scopeKey),
				),
			);
		await stageInternalEvent(tx, ctx, event, action.id);
		return updatedTags;
	});
	if (!nextTags) return;

	// Mirror the removal into ctx.context.tags so later condition nodes in
	// the same run see the contact without the tag. Plan 6 Unit RR11 /
	// Task 5 (F6).
	ctx.context.tags = nextTags;
};

export const tagHandlers: ActionRegistry = {
	tag_add: tagAdd,
	tag_remove: tagRemove,
};
