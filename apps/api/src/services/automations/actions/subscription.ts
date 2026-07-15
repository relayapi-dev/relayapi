// apps/api/src/services/automations/actions/subscription.ts
//
// subscribe_list / unsubscribe_list — upsert rows in `contact_subscriptions`,
// setting `unsubscribedAt` to null on subscribe and to NOW on unsubscribe.
//
// opt_in_channel / opt_out_channel — record immutable evidence through the
// canonical consent ledger used by send-time enforcement.

import {
	contactSubscriptions,
	contactChannels,
	contacts,
	subscriptionLists,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import {
	normalizeRecipientIdentifier,
	recordContactConsent,
} from "../../contact-consent";
import type { ActionHandler, ActionRegistry } from "./types";

type SubscribeListAction = Extract<Action, { type: "subscribe_list" }>;
type UnsubscribeListAction = Extract<Action, { type: "unsubscribe_list" }>;
type OptInChannelAction = Extract<Action, { type: "opt_in_channel" }>;
type OptOutChannelAction = Extract<Action, { type: "opt_out_channel" }>;

async function assertListScope(
	action: SubscribeListAction | UnsubscribeListAction,
	ctx: Parameters<ActionHandler>[1],
) {
	const list = await ctx.db.query.subscriptionLists.findFirst({
		where: and(
			eq(subscriptionLists.id, action.list_id),
			eq(subscriptionLists.organizationId, ctx.organizationId),
			...(ctx.workspaceId
				? [eq(subscriptionLists.workspaceId, ctx.workspaceId)]
				: []),
		),
	});
	if (!list)
		throw new Error("subscription list does not belong to automation tenant");
}

const subscribeList: ActionHandler<SubscribeListAction> = async (
	action,
	ctx,
) => {
	const db = ctx.db;
	if (!db) throw new Error("subscribe_list: db binding missing");
	await assertListScope(action, ctx);
	const existing = await db.query.contactSubscriptions.findFirst({
		where: and(
			eq(contactSubscriptions.contactId, ctx.contactId),
			eq(contactSubscriptions.listId, action.list_id),
		),
	});
	if (existing) {
		await db
			.update(contactSubscriptions)
			.set({ unsubscribedAt: null, source: "automation" })
			.where(
				and(
					eq(contactSubscriptions.contactId, ctx.contactId),
					eq(contactSubscriptions.listId, action.list_id),
				),
			);
	} else {
		await db.insert(contactSubscriptions).values({
			organizationId: ctx.organizationId,
			contactId: ctx.contactId,
			listId: action.list_id,
			source: "automation",
		});
	}
};

const unsubscribeList: ActionHandler<UnsubscribeListAction> = async (
	action,
	ctx,
) => {
	const db = ctx.db;
	if (!db) throw new Error("unsubscribe_list: db binding missing");
	await assertListScope(action, ctx);
	await db
		.update(contactSubscriptions)
		.set({ unsubscribedAt: new Date(), source: "automation" })
		.where(
			and(
				eq(contactSubscriptions.contactId, ctx.contactId),
				eq(contactSubscriptions.listId, action.list_id),
			),
		);
};

// ---------------------------------------------------------------------------
// Channel opt-in / opt-out through the canonical consent ledger.
// ---------------------------------------------------------------------------

async function recordAutomationConsent(
	action: OptInChannelAction | OptOutChannelAction,
	ctx: Parameters<ActionHandler>[1],
	status: "granted" | "denied",
) {
	const db = ctx.db;
	const conditions = [
		eq(contactChannels.contactId, ctx.contactId),
		eq(contactChannels.platform, action.channel),
		eq(contacts.organizationId, ctx.organizationId),
		...(ctx.workspaceId ? [eq(contacts.workspaceId, ctx.workspaceId)] : []),
	];
	const overrideAccountId = ctx.env?.socialAccountId as string | undefined;
	if (overrideAccountId) {
		conditions.push(eq(contactChannels.socialAccountId, overrideAccountId));
	}
	const matchingRecipients = await db
		.select({
			identifier: contactChannels.identifier,
			workspaceId: contacts.workspaceId,
		})
		.from(contactChannels)
		.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
		.where(and(...conditions));
	const recipients = [
		...new Map(
			matchingRecipients.map((recipient) => [
				normalizeRecipientIdentifier(action.channel, recipient.identifier),
				recipient,
			]),
		).values(),
	];
	if (recipients.length === 0) {
		throw new Error(
			`${action.type}: contact has no ${action.channel} identifier`,
		);
	}

	await Promise.all(
		recipients.map((recipient) =>
			recordContactConsent(db, {
				organizationId: ctx.organizationId,
				workspaceId: recipient.workspaceId,
				contactId: ctx.contactId,
				channel: action.channel,
				purpose: "automation",
				identifier: recipient.identifier,
				status,
				source: "automation_action",
				occurredAt: ctx.now,
				evidence: {
					automation_id: ctx.automationId,
					run_id: ctx.runId,
					action_id: action.id,
				},
			}),
		),
	);
}

const optInChannel: ActionHandler<OptInChannelAction> = (action, ctx) =>
	recordAutomationConsent(action, ctx, "granted");

const optOutChannel: ActionHandler<OptOutChannelAction> = (action, ctx) =>
	recordAutomationConsent(action, ctx, "denied");

export const subscriptionHandlers: ActionRegistry = {
	subscribe_list: subscribeList,
	unsubscribe_list: unsubscribeList,
	opt_in_channel: optInChannel,
	opt_out_channel: optOutChannel,
};
