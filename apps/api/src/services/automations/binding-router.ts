// apps/api/src/services/automations/binding-router.ts
//
// Default-reply / welcome-message fallback for the Manychat-parity automation
// engine. Per spec §6.6 steps 7–8, this runs only when matchAndEnroll returned
// `no_candidates` or `all_filtered` — explicit paused / reentry_blocked results
// are terminal.

import {
	automationBindings,
	automations,
	inboxConversations,
	inboxMessages,
	type Database,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { enrollContact } from "./runner";
import type { InboundEvent, MatchResult } from "./trigger-matcher";
import { matchAndEnroll } from "./trigger-matcher";

export type Db = Database;

/**
 * Returns true iff this contact has never sent an inbound message on the given
 * channel before. Used to decide welcome_message vs default_reply.
 */
async function isFirstInboundOnChannel(
	db: Db,
	organizationId: string,
	contactId: string,
	channel: string,
): Promise<boolean> {
	// A conversation row is scoped per (account, channel, participant). The
	// contact may not have a `participant_platform_id` wired to all their
	// channels, so we join via contact.id if present and fall back to any
	// inbound message on a conversation for the given platform.
	const rows = await db
		.select({ id: inboxMessages.id })
		.from(inboxMessages)
		.innerJoin(
			inboxConversations,
			eq(inboxMessages.conversationId, inboxConversations.id),
		)
		.where(
			and(
				eq(inboxConversations.organizationId, organizationId),
				eq(inboxConversations.platform, channel as never),
				eq(inboxMessages.direction, "inbound"),
				sql`${inboxConversations.contactId} = ${contactId}`,
			),
		)
		.limit(1);
	return rows.length === 0;
}

async function findBinding(
	db: Db,
	params: {
		organizationId: string;
		socialAccountId: string;
		channel: string;
		bindingType: "welcome_message" | "default_reply";
	},
) {
	// Prefer account-scoped (NOT NULL social_account_id) then fall back to any
	// active binding for the channel. The new schema requires social_account_id
	// NOT NULL so this is account-scoped only in practice.
	const rows = await db
		.select({ binding: automationBindings, automation: automations })
		.from(automationBindings)
		.innerJoin(
			automations,
			eq(automationBindings.automationId, automations.id),
		)
		.where(
			and(
				eq(automationBindings.organizationId, params.organizationId),
				eq(automationBindings.socialAccountId, params.socialAccountId),
				eq(automationBindings.channel, params.channel as never),
				eq(automationBindings.bindingType, params.bindingType),
				eq(automationBindings.status, "active"),
				eq(automations.status, "active"),
			),
		)
		.orderBy(desc(automationBindings.updatedAt))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Fallback binding dispatcher. Only fires for `no_candidates`/`all_filtered`
 * results from matchAndEnroll. Welcome_message takes precedence over
 * default_reply when the contact's first inbound message arrives.
 */
export async function routeBinding(
	db: Db,
	event: InboundEvent,
	env: Record<string, unknown>,
): Promise<MatchResult> {
	// Welcome message is checked first — but only on DMs (spec §6.6 step 8).
	// Comments and story replies are intentionally excluded: a welcome flow
	// belongs in the DM conversation thread, not under a post or ephemeral
	// story reply surface.
	// Bindings are account-scoped (social_account_id NOT NULL in the schema),
	// so internal events without an account id (tag_applied, field_changed,
	// conversion_event, ref_link_click, schedule) never match a binding.
	const isInboundMessage =
		event.kind === "dm_received" && !!event.socialAccountId;

	if (isInboundMessage) {
		const firstInbound = await isFirstInboundOnChannel(
			db,
			event.organizationId,
			event.contactId,
			event.channel,
		);
		if (firstInbound) {
			const welcome = await findBinding(db, {
				organizationId: event.organizationId,
				socialAccountId: event.socialAccountId as string,
				channel: event.channel,
				bindingType: "welcome_message",
			});
			if (welcome) {
				try {
					const { runId } = await enrollContact(db, {
						automationId: welcome.automation.id,
						organizationId: event.organizationId,
						contactId: event.contactId,
						conversationId: event.conversationId,
						channel: event.channel,
						entrypointId: null,
						bindingId: welcome.binding.id,
						contextOverrides: { triggerEvent: event },
						env,
					});
					return {
						matched: true,
						entrypointId: welcome.binding.id, // semantic: this is the binding id surfaced to the caller
						automationId: welcome.automation.id,
						runId,
					};
				} catch {
					// fall through — treat as no-match
				}
			}
		}
	}

	// Default reply — only on DMs (always carry a social account id).
	if (event.kind === "dm_received" && event.socialAccountId) {
		const defaultReply = await findBinding(db, {
			organizationId: event.organizationId,
			socialAccountId: event.socialAccountId,
			channel: event.channel,
			bindingType: "default_reply",
		});
		if (defaultReply) {
			try {
				const { runId } = await enrollContact(db, {
					automationId: defaultReply.automation.id,
					organizationId: event.organizationId,
					contactId: event.contactId,
					conversationId: event.conversationId,
					channel: event.channel,
					entrypointId: null,
					bindingId: defaultReply.binding.id,
					contextOverrides: { triggerEvent: event },
					env,
				});
				return {
					matched: true,
					entrypointId: defaultReply.binding.id,
					automationId: defaultReply.automation.id,
					runId,
				};
			} catch {
				// fall through
			}
		}
	}

	return { matched: false, reason: "no_candidates" };
}

/**
 * Single-entry-point chain used by the inbox event processor: tries the
 * entrypoint matcher first and falls through to binding routing only for
 * `no_candidates` / `all_filtered` results. Paused / reentry_blocked bubble up
 * unchanged.
 */
export async function matchAndEnrollOrBinding(
	db: Db,
	event: InboundEvent,
	env: Record<string, unknown>,
): Promise<MatchResult> {
	const first = await matchAndEnroll(db, event, env);
	if (first.matched) return first;
	if (first.reason === "no_candidates" || first.reason === "all_filtered") {
		return routeBinding(db, event, env);
	}
	return first;
}
