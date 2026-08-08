// apps/api/src/services/automations/actions/subscription.ts
//
// subscribe_list / unsubscribe_list — atomically project current membership in
// `contact_subscriptions` and append immutable transition evidence.
//
// opt_in_channel / opt_out_channel — record immutable evidence through the
// canonical consent ledger used by send-time enforcement.

import { contactChannels, contacts, subscriptionLists } from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireConsentHmacKeyConfig } from "../../../lib/consent-hmac";
import type { Action } from "../../../schemas/automation-actions";
import {
	normalizeRecipientIdentifier,
	recordContactConsent,
} from "../../contact-consent";
import { decryptContactChannelRows } from "../../contact-protection";
import { transitionContactSubscription } from "../../contact-subscription-transitions";
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
			ctx.workspaceId
				? eq(subscriptionLists.workspaceId, ctx.workspaceId)
				: isNull(subscriptionLists.workspaceId),
		),
	});
	if (!list)
		throw new Error("subscription list does not belong to automation tenant");
	return list;
}

const subscribeList: ActionHandler<SubscribeListAction> = async (
	action,
	ctx,
) => {
	const db = ctx.db;
	if (!db) throw new Error("subscribe_list: db binding missing");
	const list = await assertListScope(action, ctx);
	await transitionContactSubscription(db, {
		organizationId: ctx.organizationId,
		scopeKey: list.scopeKey,
		contactId: ctx.contactId,
		listId: action.list_id,
		type: "subscribed",
		source: "automation",
		actorId: ctx.automationId,
		occurredAt: ctx.now,
	});
};

const unsubscribeList: ActionHandler<UnsubscribeListAction> = async (
	action,
	ctx,
) => {
	const db = ctx.db;
	if (!db) throw new Error("unsubscribe_list: db binding missing");
	const list = await assertListScope(action, ctx);
	await transitionContactSubscription(db, {
		organizationId: ctx.organizationId,
		scopeKey: list.scopeKey,
		contactId: ctx.contactId,
		listId: action.list_id,
		type: "unsubscribed",
		source: "automation",
		actorId: ctx.automationId,
		occurredAt: ctx.now,
	});
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
			id: contactChannels.id,
			organizationId: contactChannels.organizationId,
			identifierCiphertext: contactChannels.identifierCiphertext,
			identifierHash: contactChannels.identifierHash,
			identityKeyFingerprint: contactChannels.identityKeyFingerprint,
			workspaceId: contacts.workspaceId,
		})
		.from(contactChannels)
		.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
		.where(and(...conditions));
	const keyConfig = requireConsentHmacKeyConfig(ctx.env.ENCRYPTION_KEY);
	const plaintextRecipients = await decryptContactChannelRows(
		keyConfig,
		matchingRecipients,
	);
	const recipients = [
		...new Map(
			plaintextRecipients.map((recipient) => [
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
			recordContactConsent(db, keyConfig, {
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
