import { contacts, customFieldDefinitions, customFieldValues } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { resolveTemplatedValue } from "../resolve-templated-value";
import type { NodeHandler } from "../types";

function serialize(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

export const fieldSetHandler: NodeHandler = async (ctx) => {
	const fieldKey = ctx.node.config.field as string | undefined;
	const rawValue = ctx.node.config.value;
	if (!fieldKey) return { kind: "fail", error: "field_set missing 'field'" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "no contact" };

	const def = await ctx.db.query.customFieldDefinitions.findFirst({
		where: and(
			eq(customFieldDefinitions.organizationId, ctx.enrollment.organization_id),
			eq(customFieldDefinitions.slug, fieldKey),
		),
	});
	if (!def) {
		return { kind: "fail", error: `custom field '${fieldKey}' not defined` };
	}

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});
	const value = resolveTemplatedValue(rawValue, {
		contact: (contact as Record<string, unknown> | null | undefined) ?? null,
		state: ctx.enrollment.state,
	});

	await ctx.db
		.insert(customFieldValues)
		.values({
			organizationId: ctx.enrollment.organization_id,
			contactId: ctx.enrollment.contact_id,
			definitionId: def.id,
			value: serialize(value),
		})
		.onConflictDoUpdate({
			target: [customFieldValues.definitionId, customFieldValues.contactId],
			set: { value: serialize(value), updatedAt: new Date() },
		});

	return { kind: "next" };
};

export const fieldClearHandler: NodeHandler = async (ctx) => {
	const fieldKey = ctx.node.config.field as string | undefined;
	if (!fieldKey) return { kind: "fail", error: "field_clear missing 'field'" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "no contact" };

	const def = await ctx.db.query.customFieldDefinitions.findFirst({
		where: and(
			eq(customFieldDefinitions.organizationId, ctx.enrollment.organization_id),
			eq(customFieldDefinitions.slug, fieldKey),
		),
	});
	if (!def) return { kind: "next" }; // no-op if undefined

	await ctx.db
		.delete(customFieldValues)
		.where(
			and(
				eq(customFieldValues.definitionId, def.id),
				eq(customFieldValues.contactId, ctx.enrollment.contact_id),
			),
		);

	return { kind: "next" };
};
