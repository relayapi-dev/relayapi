import { contactSubscriptions, subscriptionLists } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { NodeHandler } from "../types";

export const subscriptionAddHandler: NodeHandler = async (ctx) => {
	const listId = ctx.node.config.list_id as string | undefined;
	if (!listId) return { kind: "fail", error: "subscription_add missing 'list_id'" };
	if (!ctx.enrollment.contact_id) {
		return { kind: "fail", error: "enrollment has no contact_id" };
	}

	const list = await ctx.db.query.subscriptionLists.findFirst({
		where: and(
			eq(subscriptionLists.id, listId),
			eq(subscriptionLists.organizationId, ctx.enrollment.organization_id),
		),
	});
	if (!list) {
		return { kind: "fail", error: `subscription list '${listId}' not found` };
	}

	await ctx.db
		.insert(contactSubscriptions)
		.values({
			contactId: ctx.enrollment.contact_id,
			listId,
			source: "automation",
			unsubscribedAt: null,
		})
		.onConflictDoUpdate({
			target: [contactSubscriptions.contactId, contactSubscriptions.listId],
			set: {
				unsubscribedAt: null,
				source: "automation",
				subscribedAt: new Date(),
			},
		});

	return {
		kind: "next",
		state_patch: {
			last_subscription_list_id: listId,
			last_subscription_action: "subscribed",
		},
	};
};

export const subscriptionRemoveHandler: NodeHandler = async (ctx) => {
	const listId = ctx.node.config.list_id as string | undefined;
	if (!listId) return { kind: "fail", error: "subscription_remove missing 'list_id'" };
	if (!ctx.enrollment.contact_id) {
		return { kind: "fail", error: "enrollment has no contact_id" };
	}

	const list = await ctx.db.query.subscriptionLists.findFirst({
		where: and(
			eq(subscriptionLists.id, listId),
			eq(subscriptionLists.organizationId, ctx.enrollment.organization_id),
		),
	});
	if (!list) {
		return { kind: "fail", error: `subscription list '${listId}' not found` };
	}

	await ctx.db
		.insert(contactSubscriptions)
		.values({
			contactId: ctx.enrollment.contact_id,
			listId,
			source: "automation",
			unsubscribedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [contactSubscriptions.contactId, contactSubscriptions.listId],
			set: {
				unsubscribedAt: new Date(),
				source: "automation",
			},
		});

	return {
		kind: "next",
		state_patch: {
			last_subscription_list_id: listId,
			last_subscription_action: "unsubscribed",
		},
	};
};
