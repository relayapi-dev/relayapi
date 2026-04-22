// apps/api/src/services/automations/actions/notify.ts
//
// notify_admin — inserts an in-app notification row for each recipient (or
// every member of the organization when `recipient_user_ids` is omitted).

import { member, notifications } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import { applyMergeTags } from "../merge-tags";
import type { ActionHandler, ActionRegistry } from "./types";

type NotifyAdminAction = Extract<Action, { type: "notify_admin" }>;

function buildMergeCtx(ctx: any) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

const notifyAdmin: ActionHandler<NotifyAdminAction> = async (action, ctx) => {
	const db = ctx.db;
	if (!db) throw new Error("notify_admin: db binding missing");
	const mergeCtx = buildMergeCtx(ctx);
	const title = applyMergeTags(action.title, mergeCtx);
	const body = applyMergeTags(action.body, mergeCtx);

	let recipientIds = action.recipient_user_ids ?? [];
	if (recipientIds.length === 0) {
		const rows = await db
			.select({ userId: member.userId })
			.from(member)
			.where(eq(member.organizationId, ctx.organizationId));
		recipientIds = rows.map((r: { userId: string }) => r.userId);
	}
	if (recipientIds.length === 0) return;

	const data: Record<string, unknown> = {
		automation_id: ctx.automationId,
		run_id: ctx.runId,
		contact_id: ctx.contactId,
	};
	if (action.link) data.link = applyMergeTags(action.link, mergeCtx);

	await db.insert(notifications).values(
		recipientIds.map((userId: string) => ({
			userId,
			organizationId: ctx.organizationId,
			type: "automation_notice",
			title,
			body,
			data,
		})),
	);
};

export const notifyHandlers: ActionRegistry = {
	notify_admin: notifyAdmin,
};
