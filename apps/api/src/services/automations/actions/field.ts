// apps/api/src/services/automations/actions/field.ts
//
// field_set / field_clear — upsert / delete a row in `custom_field_values`
// keyed by (definition_id, contact_id). The definition is resolved by
// `custom_field_definitions.slug` scoped to the current organization. If the
// definition doesn't exist, the action fails (operator must create the field
// via the dashboard or API first).

import {
	customFieldDefinitions,
	customFieldValues,
	generateId,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import { applyMergeTags } from "../merge-tags";
import type { ActionHandler, ActionRegistry } from "./types";

type FieldSetAction = Extract<Action, { type: "field_set" }>;
type FieldClearAction = Extract<Action, { type: "field_clear" }>;

function buildMergeCtx(ctx: any) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

async function resolveDefinitionId(
	db: any,
	organizationId: string,
	slug: string,
): Promise<string | null> {
	const row = await db.query.customFieldDefinitions.findFirst({
		where: and(
			eq(customFieldDefinitions.organizationId, organizationId),
			eq(customFieldDefinitions.slug, slug),
		),
	});
	return row?.id ?? null;
}

const fieldSet: ActionHandler<FieldSetAction> = async (action, ctx) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("field_set: db binding missing");
	const definitionId = await resolveDefinitionId(
		db,
		ctx.organizationId,
		action.field,
	);
	if (!definitionId) {
		throw new Error(`field_set: custom field "${action.field}" not found`);
	}
	const value = applyMergeTags(action.value, buildMergeCtx(ctx));
	const existing = await db.query.customFieldValues.findFirst({
		where: and(
			eq(customFieldValues.definitionId, definitionId),
			eq(customFieldValues.contactId, ctx.contactId),
		),
	});
	if (existing) {
		await db
			.update(customFieldValues)
			.set({ value, updatedAt: new Date() })
			.where(eq(customFieldValues.id, existing.id));
	} else {
		await db.insert(customFieldValues).values({
			id: generateId("cfv_"),
			definitionId,
			contactId: ctx.contactId,
			organizationId: ctx.organizationId,
			value,
		});
	}
};

const fieldClear: ActionHandler<FieldClearAction> = async (action, ctx) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("field_clear: db binding missing");
	const definitionId = await resolveDefinitionId(
		db,
		ctx.organizationId,
		action.field,
	);
	if (!definitionId) {
		// Treat unknown field as a no-op on clear: nothing to erase.
		return;
	}
	await db
		.delete(customFieldValues)
		.where(
			and(
				eq(customFieldValues.definitionId, definitionId),
				eq(customFieldValues.contactId, ctx.contactId),
			),
		);
};

export const fieldHandlers: ActionRegistry = {
	field_set: fieldSet,
	field_clear: fieldClear,
};
