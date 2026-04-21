// apps/api/src/services/automations/actions/subscription.ts
//
// subscribe_list / unsubscribe_list — upsert rows in `contact_subscriptions`,
// setting `unsubscribedAt` to null on subscribe and to NOW on unsubscribe.
//
// opt_in_channel / opt_out_channel — the current schema has no per-channel
// opt-out column on contacts (contacts.opted_in is a global flag, and
// contact_channels only tracks channel membership, not opt-out). To avoid a
// new migration in this unit we persist the opt-out state as a custom field
// with a well-known key `__channel_opt_out_<channel>` = "1" (set) or delete
// the row (cleared). A follow-up migration should introduce a dedicated
// `contact_channels.opted_out` column.

import {
	contactSubscriptions,
	customFieldDefinitions,
	customFieldValues,
	generateId,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type SubscribeListAction = Extract<Action, { type: "subscribe_list" }>;
type UnsubscribeListAction = Extract<Action, { type: "unsubscribe_list" }>;
type OptInChannelAction = Extract<Action, { type: "opt_in_channel" }>;
type OptOutChannelAction = Extract<Action, { type: "opt_out_channel" }>;

const subscribeList: ActionHandler<SubscribeListAction> = async (
	action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("subscribe_list: db binding missing");
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
	const db = ctx.env?.db;
	if (!db) throw new Error("unsubscribe_list: db binding missing");
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
// Channel opt-in / opt-out via custom-field convention.
// ---------------------------------------------------------------------------

async function ensureOptOutDefinition(
	db: any,
	organizationId: string,
	channel: string,
): Promise<string> {
	const slug = `__channel_opt_out_${channel}`;
	const existing = await db.query.customFieldDefinitions.findFirst({
		where: and(
			eq(customFieldDefinitions.organizationId, organizationId),
			eq(customFieldDefinitions.slug, slug),
		),
	});
	if (existing) return existing.id;
	const id = generateId("cfd_");
	await db.insert(customFieldDefinitions).values({
		id,
		organizationId,
		name: `Channel opt-out (${channel})`,
		slug,
		type: "boolean",
	});
	return id;
}

const optInChannel: ActionHandler<OptInChannelAction> = async (action, ctx) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("opt_in_channel: db binding missing");
	const definitionId = await ensureOptOutDefinition(
		db,
		ctx.organizationId,
		action.channel,
	);
	// Opt-in = clear any existing opt-out flag.
	await db
		.delete(customFieldValues)
		.where(
			and(
				eq(customFieldValues.definitionId, definitionId),
				eq(customFieldValues.contactId, ctx.contactId),
			),
		);
};

const optOutChannel: ActionHandler<OptOutChannelAction> = async (
	action,
	ctx,
) => {
	const db = ctx.env?.db;
	if (!db) throw new Error("opt_out_channel: db binding missing");
	const definitionId = await ensureOptOutDefinition(
		db,
		ctx.organizationId,
		action.channel,
	);
	const existing = await db.query.customFieldValues.findFirst({
		where: and(
			eq(customFieldValues.definitionId, definitionId),
			eq(customFieldValues.contactId, ctx.contactId),
		),
	});
	if (existing) {
		await db
			.update(customFieldValues)
			.set({ value: "1", updatedAt: new Date() })
			.where(eq(customFieldValues.id, existing.id));
	} else {
		await db.insert(customFieldValues).values({
			id: generateId("cfv_"),
			definitionId,
			contactId: ctx.contactId,
			organizationId: ctx.organizationId,
			value: "1",
		});
	}
};

export const subscriptionHandlers: ActionRegistry = {
	subscribe_list: subscribeList,
	unsubscribe_list: unsubscribeList,
	opt_in_channel: optInChannel,
	opt_out_channel: optOutChannel,
};
