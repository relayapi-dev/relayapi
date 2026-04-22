// apps/api/src/services/automations/actions/field.ts
//
// field_set / field_clear — upsert / delete a row in `custom_field_values`
// keyed by (definition_id, contact_id). The definition is resolved by
// `custom_field_definitions.slug` scoped to the current organization. If the
// definition doesn't exist, the action fails (operator must create the field
// via the dashboard or API first).
//
// After a successful mutation we emit an internal `field_changed` event so
// entrypoints listening for custom-field changes fire.

import {
	customFieldDefinitions,
	customFieldValues,
	generateId,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import { emitInternalEvent } from "../internal-events";
import { applyMergeTags } from "../merge-tags";
import type { InboundEvent } from "../trigger-matcher";
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

function internalFieldEvent(
	ctx: any,
	fieldKey: string,
	before: unknown,
	after: unknown,
	actionId: string,
): InboundEvent {
	const triggerEvent = (ctx.context as Record<string, unknown>)?.triggerEvent as
		| { payload?: { _event_depth?: number } }
		| undefined;
	const depth = triggerEvent?.payload?._event_depth ?? 0;
	return {
		kind: "field_changed",
		channel: (ctx.channel ?? "instagram") as InboundEvent["channel"],
		organizationId: ctx.organizationId,
		socialAccountId: null,
		contactId: ctx.contactId,
		conversationId: ctx.conversationId ?? null,
		fieldKey,
		fieldValueBefore: before,
		fieldValueAfter: after,
		payload: {
			source: "automation",
			automation_id: ctx.automationId,
			run_id: ctx.runId,
			action_id: actionId,
			_event_depth: depth,
		},
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
	const db = ctx.db;
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
	const before = existing?.value ?? null;
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

	await emitInternalEvent(
		db,
		internalFieldEvent(ctx, action.field, before, value, action.id),
		ctx.env,
	);
};

const fieldClear: ActionHandler<FieldClearAction> = async (action, ctx) => {
	const db = ctx.db;
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
	const existing = await db.query.customFieldValues.findFirst({
		where: and(
			eq(customFieldValues.definitionId, definitionId),
			eq(customFieldValues.contactId, ctx.contactId),
		),
	});
	const before = existing?.value ?? null;
	await db
		.delete(customFieldValues)
		.where(
			and(
				eq(customFieldValues.definitionId, definitionId),
				eq(customFieldValues.contactId, ctx.contactId),
			),
		);

	if (existing) {
		await emitInternalEvent(
			db,
			internalFieldEvent(ctx, action.field, before, null, action.id),
			ctx.env,
		);
	}
};

export const fieldHandlers: ActionRegistry = {
	field_set: fieldSet,
	field_clear: fieldClear,
};
