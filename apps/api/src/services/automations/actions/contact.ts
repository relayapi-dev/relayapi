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
import { and, eq, isNull } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import {
	normalizeRecipientIdentifier,
	recordContactConsentInTransaction,
} from "../../contact-consent";
import { applyMergeTags } from "../merge-tags";
import type { ActionHandler, ActionRegistry } from "./types";

type DeleteContactAction = Extract<Action, { type: "delete_contact" }>;
type ContactFieldSetAction = Extract<Action, { type: "contact_field_set" }>;

const CONSENT_PURPOSES = ["marketing", "automation", "service"] as const;

const contactFieldSet: ActionHandler<ContactFieldSetAction> = async (
	action,
	ctx,
) => {
	const value = applyMergeTags(action.value, {
		contact:
			(ctx.context.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context,
	}).trim();
	if (!value)
		throw new Error(`contact_field_set: ${action.field} cannot be empty`);

	const saved = await ctx.db.transaction(async (tx) => {
		const [existing] = await tx
			.select()
			.from(contacts)
			.where(
				and(
					eq(contacts.id, ctx.contactId),
					eq(contacts.organizationId, ctx.organizationId),
					ctx.workspaceId
						? eq(contacts.workspaceId, ctx.workspaceId)
						: isNull(contacts.workspaceId),
				),
			)
			.limit(1)
			.for("update");
		if (!existing) {
			throw new Error(
				"contact_field_set: contact does not belong to automation scope",
			);
		}

		const previous = existing[action.field];
		const [updated] = await tx
			.update(contacts)
			.set({ [action.field]: value, updatedAt: new Date() })
			.where(eq(contacts.id, existing.id))
			.returning();
		if (!updated) throw new Error("contact_field_set: contact update failed");

		if (
			(action.field === "email" || action.field === "phone") &&
			typeof previous === "string" &&
			previous.length > 0
		) {
			const channels =
				action.field === "email" ? ["email"] : ["sms", "whatsapp"];
			for (const channel of channels) {
				if (
					normalizeRecipientIdentifier(channel, previous) ===
					normalizeRecipientIdentifier(channel, value)
				) {
					continue;
				}
				for (const purpose of CONSENT_PURPOSES) {
					await recordContactConsentInTransaction(tx, {
						organizationId: ctx.organizationId,
						workspaceId: updated.workspaceId,
						contactId: updated.id,
						channel,
						purpose,
						identifier: previous,
						status: "denied",
						source: "automation_contact_identifier_replaced",
						occurredAt: ctx.now,
						evidence: {
							automation_id: ctx.automationId,
							run_id: ctx.runId,
							action_id: action.id,
						},
					});
				}
			}
		}
		return updated;
	});

	const currentContact =
		ctx.context.contact && typeof ctx.context.contact === "object"
			? (ctx.context.contact as Record<string, unknown>)
			: {};
	ctx.context.contact = {
		...currentContact,
		[action.field]: saved[action.field],
	};
};

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
	contact_field_set: contactFieldSet,
	delete_contact: deleteContact,
};
