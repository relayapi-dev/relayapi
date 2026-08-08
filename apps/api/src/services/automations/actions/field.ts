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
	contacts,
	customFieldDefinitions,
	customFieldValues,
	type Database,
	generateId,
} from "@relayapi/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import {
	resolveTriggeringSocialAccountId,
	stageInternalEvent,
} from "../internal-events";
import { applyMergeTags } from "../merge-tags";
import type { InboundEvent } from "../trigger-matcher";
import type { RunContext } from "../types";
import type { ActionHandler, ActionRegistry } from "./types";

type FieldSetAction = Extract<Action, { type: "field_set" }>;
type FieldClearAction = Extract<Action, { type: "field_clear" }>;

function buildMergeCtx(ctx: RunContext) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

function internalFieldEvent(
	ctx: RunContext,
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
		socialAccountId: resolveTriggeringSocialAccountId(ctx),
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

async function resolveDefinition(
	db: Database,
	organizationId: string,
	workspaceId: string | null | undefined,
	slug: string,
): Promise<{ id: string; scopeKey: string } | null> {
	const [row] = await db
		.select({
			id: customFieldDefinitions.id,
			scopeKey: customFieldDefinitions.scopeKey,
		})
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.organizationId, organizationId),
				eq(customFieldDefinitions.slug, slug),
				workspaceId
					? or(
							eq(customFieldDefinitions.workspaceId, workspaceId),
							isNull(customFieldDefinitions.workspaceId),
						)
					: isNull(customFieldDefinitions.workspaceId),
			),
		)
		// Prefer an exact workspace definition over the organization fallback.
		.orderBy(desc(customFieldDefinitions.workspaceId))
		.limit(1);
	return row ?? null;
}

const fieldSet: ActionHandler<FieldSetAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("field_set: db binding missing");
	const definition = await resolveDefinition(
		db,
		ctx.organizationId,
		ctx.workspaceId,
		action.field,
	);
	if (!definition) {
		throw new Error(`field_set: custom field "${action.field}" not found`);
	}
	const value = applyMergeTags(action.value, buildMergeCtx(ctx));
	const scopeKey = ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org";
	const changed = await db.transaction(async (tx) => {
		// The contact row is the stable serialization point for values that do
		// not exist yet; locking only custom_field_values cannot protect two
		// concurrent first writes.
		const [contact] = await tx
			.select({ id: contacts.id })
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
		if (!contact) throw new Error("field_set: contact not found in run scope");
		const [existing] = await tx
			.select({
				id: customFieldValues.id,
				value: customFieldValues.value,
			})
			.from(customFieldValues)
			.where(
				and(
					eq(customFieldValues.definitionId, definition.id),
					eq(customFieldValues.contactId, ctx.contactId),
					eq(customFieldValues.organizationId, ctx.organizationId),
					eq(customFieldValues.scopeKey, scopeKey),
				),
			)
			.limit(1);
		const before = existing?.value ?? null;
		if (before === value) return false;
		if (existing) {
			await tx
				.update(customFieldValues)
				.set({ value, updatedAt: ctx.now })
				.where(
					and(
						eq(customFieldValues.id, existing.id),
						eq(customFieldValues.organizationId, ctx.organizationId),
						eq(customFieldValues.scopeKey, scopeKey),
					),
				);
		} else {
			await tx.insert(customFieldValues).values({
				id: generateId("cfv_"),
				definitionId: definition.id,
				contactId: ctx.contactId,
				organizationId: ctx.organizationId,
				scopeKey,
				definitionScopeKey: definition.scopeKey,
				value,
			});
		}
		await stageInternalEvent(
			tx,
			ctx,
			internalFieldEvent(ctx, action.field, before, value, action.id),
			action.id,
		);
		return true;
	});

	// Mirror the mutation into ctx.context.fields so same-run condition nodes
	// can branch on the freshly written value. Plan 6 Unit RR11 / Task 5
	// (F6) — without this, a field_set → condition(fields.X == Y) → true
	// flow always takes the false branch because ctx.context was hydrated at
	// enroll time.
	const currentFields =
		ctx.context.fields && typeof ctx.context.fields === "object"
			? (ctx.context.fields as Record<string, unknown>)
			: {};
	ctx.context.fields = { ...currentFields, [action.field]: value };
	if (!changed) return;
};

const fieldClear: ActionHandler<FieldClearAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("field_clear: db binding missing");
	const definition = await resolveDefinition(
		db,
		ctx.organizationId,
		ctx.workspaceId,
		action.field,
	);
	if (!definition) {
		// Treat unknown field as a no-op on clear: nothing to erase.
		return;
	}
	const scopeKey = ctx.workspaceId ? `ws/${ctx.workspaceId}` : "org";
	const changed = await db.transaction(async (tx) => {
		const [contact] = await tx
			.select({ id: contacts.id })
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
		if (!contact)
			throw new Error("field_clear: contact not found in run scope");
		const [existing] = await tx
			.select({
				id: customFieldValues.id,
				value: customFieldValues.value,
			})
			.from(customFieldValues)
			.where(
				and(
					eq(customFieldValues.definitionId, definition.id),
					eq(customFieldValues.contactId, ctx.contactId),
					eq(customFieldValues.organizationId, ctx.organizationId),
					eq(customFieldValues.scopeKey, scopeKey),
				),
			)
			.limit(1);
		if (!existing) return false;
		await tx
			.delete(customFieldValues)
			.where(
				and(
					eq(customFieldValues.id, existing.id),
					eq(customFieldValues.organizationId, ctx.organizationId),
					eq(customFieldValues.scopeKey, scopeKey),
				),
			);
		await stageInternalEvent(
			tx,
			ctx,
			internalFieldEvent(ctx, action.field, existing.value, null, action.id),
			action.id,
		);
		return true;
	});

	// Drop the key from ctx.context.fields if it was present. Plan 6 Unit RR11
	// / Task 5 (F6): keep same-run condition evaluation consistent with DB.
	if (ctx.context.fields && typeof ctx.context.fields === "object") {
		const next = { ...(ctx.context.fields as Record<string, unknown>) };
		delete next[action.field];
		ctx.context.fields = next;
	}

	if (!changed) return;
};

export const fieldHandlers: ActionRegistry = {
	field_set: fieldSet,
	field_clear: fieldClear,
};
