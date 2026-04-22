// apps/api/src/services/automations/actions/contact.ts
//
// delete_contact — hard-deletes the current contact row. Cascades to runs,
// tags (inline column), custom field values, segment memberships,
// subscriptions, conversations (set null), and channels via the FK relations
// defined in `packages/db/src/schema.ts`.
//
// Safety: the Zod schema forces `confirm: true`, but we re-check here so
// programmatic callers that bypass the schema still trip the guard.

import { contacts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type DeleteContactAction = Extract<Action, { type: "delete_contact" }>;

const deleteContact: ActionHandler<DeleteContactAction> = async (
	action,
	ctx,
) => {
	if (action.confirm !== true) {
		throw new Error("delete_contact requires confirm=true");
	}
	const db = ctx.db;
	if (!db) throw new Error("delete_contact: db binding missing");
	await db
		.delete(contacts)
		.where(
			and(
				eq(contacts.id, ctx.contactId),
				eq(contacts.organizationId, ctx.organizationId),
			),
		);
};

export const contactHandlers: ActionRegistry = {
	delete_contact: deleteContact,
};
