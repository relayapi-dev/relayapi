// apps/api/src/services/automations/actions/tag.ts
//
// tag_add / tag_remove — mutate the `contacts.tags` text[] column for the
// current contact. Tags are identified by name; there's no separate join
// table in the current schema, so "create if missing" collapses to "append
// to array if not already present".

import { contacts } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type TagAddAction = Extract<Action, { type: "tag_add" }>;
type TagRemoveAction = Extract<Action, { type: "tag_remove" }>;

const tagAdd: ActionHandler<TagAddAction> = async (action, ctx) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("tag_add: db binding missing");
	const tag = action.tag.trim();
	if (!tag) return;
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
};

const tagRemove: ActionHandler<TagRemoveAction> = async (action, ctx) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("tag_remove: db binding missing");
	const tag = action.tag.trim();
	if (!tag) return;
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
};

export const tagHandlers: ActionRegistry = {
	tag_add: tagAdd,
	tag_remove: tagRemove,
};
