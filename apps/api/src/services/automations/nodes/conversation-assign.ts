import { contacts, inboxConversations, member } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { resolveTemplatedValue } from "../resolve-templated-value";
import type { NodeHandler } from "../types";

export const conversationAssignHandler: NodeHandler = async (ctx) => {
	const rawAssigneeUserId = ctx.node.config.assignee_user_id;
	if (!rawAssigneeUserId) {
		return { kind: "fail", error: "conversation_assign missing 'assignee_user_id'" };
	}
	if (!ctx.enrollment.conversation_id) {
		return { kind: "fail", error: "enrollment has no conversation_id" };
	}

	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;
	const assigneeUserId = String(
		resolveTemplatedValue(rawAssigneeUserId, {
			contact: (contact as Record<string, unknown> | null | undefined) ?? null,
			state: ctx.enrollment.state,
		}) ?? "",
	).trim();
	if (!assigneeUserId) {
		return { kind: "fail", error: "conversation_assign resolved an empty assignee_user_id" };
	}

	const orgMember = await ctx.db.query.member.findFirst({
		where: and(
			eq(member.organizationId, ctx.enrollment.organization_id),
			eq(member.userId, assigneeUserId),
		),
	});
	if (!orgMember) {
		return {
			kind: "fail",
			error: `organization member '${assigneeUserId}' not found`,
		};
	}

	const [updated] = await ctx.db
		.update(inboxConversations)
		.set({
			assignedUserId: assigneeUserId,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(inboxConversations.id, ctx.enrollment.conversation_id),
				eq(inboxConversations.organizationId, ctx.enrollment.organization_id),
			),
		)
		.returning({ id: inboxConversations.id });

	if (!updated) {
		return {
			kind: "fail",
			error: `conversation '${ctx.enrollment.conversation_id}' not found`,
		};
	}

	return {
		kind: "next",
		state_patch: {
			last_assigned_user_id: assigneeUserId,
		},
	};
};
