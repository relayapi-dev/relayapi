import { inboxConversations } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { NodeHandler } from "../types";

export const conversationStatusHandler: NodeHandler = async (ctx) => {
	const status = ctx.node.config.status as string | undefined;
	if (!status) {
		return { kind: "fail", error: "conversation_status missing 'status'" };
	}
	if (!ctx.enrollment.conversation_id) {
		return { kind: "fail", error: "enrollment has no conversation_id" };
	}

	const [updated] = await ctx.db
		.update(inboxConversations)
		.set({
			status: status as "open" | "archived" | "snoozed",
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
			last_conversation_status: status,
		},
	};
};
