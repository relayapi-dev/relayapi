// apps/api/src/services/automations/actions/conversation.ts
//
// Conversation-state mutations — assign/unassign, open/close/snooze. All rows
// live in `inbox_conversations`. These actions are no-ops when the run has no
// conversationId set.

import { inboxConversations, member } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type AssignConversationAction = Extract<
	Action,
	{ type: "assign_conversation" }
>;
type UnassignConversationAction = Extract<
	Action,
	{ type: "unassign_conversation" }
>;
type ConversationOpenAction = Extract<Action, { type: "conversation_open" }>;
type ConversationCloseAction = Extract<Action, { type: "conversation_close" }>;
type ConversationSnoozeAction = Extract<
	Action,
	{ type: "conversation_snooze" }
>;

async function resolveRoundRobinUserId(
	db: any,
	organizationId: string,
): Promise<string | null> {
	// v1 "round robin": pick the first user in the organization by member row
	// order. Replace with actual rotation logic (last_assigned_at ordering)
	// when teammate load-balancing is a real requirement.
	const row = await db.query.member.findFirst({
		where: eq(member.organizationId, organizationId),
	});
	return row?.userId ?? null;
}

async function requireConversationId(ctx: any): Promise<string | null> {
	return ctx.conversationId ?? null;
}

const assignConversation: ActionHandler<AssignConversationAction> = async (
	action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("assign_conversation: db binding missing");
	const conversationId = await requireConversationId(ctx);
	if (!conversationId) return; // no-op when run has no conversation

	let targetUserId: string | null;
	if (action.user_id === "round_robin") {
		targetUserId = await resolveRoundRobinUserId(db, ctx.organizationId);
	} else if (action.user_id === "unassigned") {
		targetUserId = null;
	} else {
		targetUserId = action.user_id;
	}

	await db
		.update(inboxConversations)
		.set({ assignedUserId: targetUserId, updatedAt: new Date() })
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, ctx.organizationId),
			),
		);
};

const unassignConversation: ActionHandler<UnassignConversationAction> = async (
	_action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("unassign_conversation: db binding missing");
	const conversationId = await requireConversationId(ctx);
	if (!conversationId) return;
	await db
		.update(inboxConversations)
		.set({ assignedUserId: null, updatedAt: new Date() })
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, ctx.organizationId),
			),
		);
};

const conversationOpen: ActionHandler<ConversationOpenAction> = async (
	_action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("conversation_open: db binding missing");
	const conversationId = await requireConversationId(ctx);
	if (!conversationId) return;
	await db
		.update(inboxConversations)
		.set({ status: "open", updatedAt: new Date() })
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, ctx.organizationId),
			),
		);
};

const conversationClose: ActionHandler<ConversationCloseAction> = async (
	_action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("conversation_close: db binding missing");
	const conversationId = await requireConversationId(ctx);
	if (!conversationId) return;
	await db
		.update(inboxConversations)
		.set({ status: "archived", updatedAt: new Date() })
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, ctx.organizationId),
			),
		);
};

const conversationSnooze: ActionHandler<ConversationSnoozeAction> = async (
	_action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("conversation_snooze: db binding missing");
	const conversationId = await requireConversationId(ctx);
	if (!conversationId) return;
	// The inbox schema only stores status="snoozed"; it does NOT have a
	// snoozed_until column. A future migration should add one so the inbox UI
	// can auto-reopen; for now the snooze duration is stored in step_run
	// payload only.
	await db
		.update(inboxConversations)
		.set({ status: "snoozed", updatedAt: new Date() })
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, ctx.organizationId),
			),
		);
};

export const conversationHandlers: ActionRegistry = {
	assign_conversation: assignConversation,
	unassign_conversation: unassignConversation,
	conversation_open: conversationOpen,
	conversation_close: conversationClose,
	conversation_snooze: conversationSnooze,
};
