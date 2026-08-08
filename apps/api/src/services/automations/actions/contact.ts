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
import { requireConsentHmacKeyConfig } from "../../../lib/consent-hmac";
import { normalizeContactPhone } from "../../../lib/contact-phone";
import type { Action } from "../../../schemas/automation-actions";
import {
	normalizeRecipientIdentifier,
	recordContactConsentInTransaction,
} from "../../contact-consent";
import {
	eraseContactsInTransaction,
	lockContactErasureScope,
} from "../../contact-erasure";
import {
	decryptContactRow,
	protectContactEmail,
	protectContactName,
	protectContactPhone,
} from "../../contact-protection";
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
	const phoneCanonical =
		action.field === "phone" ? normalizeContactPhone(value) : null;
	if (action.field === "phone" && !phoneCanonical) {
		throw new Error(
			"contact_field_set: phone must include an international country calling code",
		);
	}
	const keyConfig = requireConsentHmacKeyConfig(ctx.env.ENCRYPTION_KEY);

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

		const plaintextExisting = await decryptContactRow(keyConfig, existing);
		const previous = plaintextExisting[action.field];
		const protectedValue =
			action.field === "name"
				? await protectContactName(
						keyConfig,
						ctx.organizationId,
						existing.id,
						value,
					)
				: action.field === "email"
					? await protectContactEmail(
							keyConfig,
							ctx.organizationId,
							existing.id,
							value,
						)
					: await protectContactPhone(
							keyConfig,
							ctx.organizationId,
							existing.id,
							value,
						);
		const [updated] = await tx
			.update(contacts)
			.set({
				...protectedValue,
				updatedAt: new Date(),
			})
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
					await recordContactConsentInTransaction(tx, keyConfig, {
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
		return { updated, value };
	});

	const currentContact =
		ctx.context.contact && typeof ctx.context.contact === "object"
			? (ctx.context.contact as Record<string, unknown>)
			: {};
	ctx.context.contact = {
		...currentContact,
		[action.field]: saved.value,
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
	const keyConfig = requireConsentHmacKeyConfig(ctx.env.ENCRYPTION_KEY);
	await db.transaction(async (tx) => {
		const scopeAuthority = await lockContactErasureScope(tx, {
			organizationId: ctx.organizationId,
			workspaceIds: [ctx.workspaceId ?? null],
			contactIds: [ctx.contactId],
		});
		const [contact] = await tx
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
			.for("update")
			.limit(1);
		if (!contact) {
			throw new Error(
				"delete_contact: contact does not belong to automation scope",
			);
		}
		const plaintextContact = await decryptContactRow(keyConfig, contact);
		await eraseContactsInTransaction(tx, {
			organizationId: ctx.organizationId,
			contacts: [plaintextContact],
			scopeAuthority,
			keyConfig,
			occurredAt: ctx.now,
			source: "automation_contact_deleted",
			evidence: {
				automation_id: ctx.automationId,
				run_id: ctx.runId,
				action_id: action.id,
			},
		});
	});
};

export const contactHandlers: ActionRegistry = {
	contact_field_set: contactFieldSet,
	delete_contact: deleteContact,
};
