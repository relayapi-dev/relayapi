// apps/api/src/services/automations/actions/automation-controls.ts
//
// pause_automations_for_contact / resume_automations_for_contact —
// INSERT/DELETE rows in `automation_contact_controls`.
//
// Scope semantics (per spec §5.4):
//   - "current": automation_id = ctx.automationId  (pause just this flow)
//   - "global":  automation_id = NULL              (pause all flows for contact)

import { automationContactControls } from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type PauseContactAutomationsAction = Extract<
	Action,
	{ type: "pause_automations_for_contact" }
>;
type ResumeContactAutomationsAction = Extract<
	Action,
	{ type: "resume_automations_for_contact" }
>;

const pauseContactAutomations: ActionHandler<
	PauseContactAutomationsAction
> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("pause_automations_for_contact: db binding missing");
	const automationId = action.scope === "global" ? null : ctx.automationId;
	const pausedUntil = action.duration_min
		? new Date(Date.now() + action.duration_min * 60_000)
		: null;

	// Unique indexes (idx_contact_controls_per_auto / idx_contact_controls_global)
	// enforce at-most-one row per (contact, automation|null). We emulate upsert
	// manually because the partial-unique indexes can't be used as ON CONFLICT
	// targets without explicit index predicates, and Drizzle's onConflictDoUpdate
	// needs a literal constraint name.
	const existing = automationId
		? await db.query.automationContactControls.findFirst({
				where: and(
					eq(automationContactControls.contactId, ctx.contactId),
					eq(automationContactControls.automationId, automationId),
				),
			})
		: await db.query.automationContactControls.findFirst({
				where: and(
					eq(automationContactControls.contactId, ctx.contactId),
					isNull(automationContactControls.automationId),
				),
			});

	if (existing) {
		await db
			.update(automationContactControls)
			.set({
				pauseReason: action.reason ?? existing.pauseReason ?? "automation",
				pausedUntil,
				updatedAt: new Date(),
			})
			.where(eq(automationContactControls.id, existing.id));
	} else {
		await db.insert(automationContactControls).values({
			organizationId: ctx.organizationId,
			contactId: ctx.contactId,
			automationId,
			pauseReason: action.reason ?? "automation",
			pausedUntil,
		});
	}
};

const resumeContactAutomations: ActionHandler<
	ResumeContactAutomationsAction
> = async (action, ctx) => {
	const db = ctx.db;
	if (!db)
		throw new Error("resume_automations_for_contact: db binding missing");
	const automationId = action.scope === "global" ? null : ctx.automationId;
	if (automationId) {
		await db
			.delete(automationContactControls)
			.where(
				and(
					eq(automationContactControls.contactId, ctx.contactId),
					eq(automationContactControls.automationId, automationId),
				),
			);
	} else {
		await db
			.delete(automationContactControls)
			.where(
				and(
					eq(automationContactControls.contactId, ctx.contactId),
					isNull(automationContactControls.automationId),
				),
			);
	}
};

export const automationControlHandlers: ActionRegistry = {
	pause_automations_for_contact: pauseContactAutomations,
	resume_automations_for_contact: resumeContactAutomations,
};
