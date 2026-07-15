import {
	contactSuppressions,
	type Database,
	inboxMessages,
} from "@relayapi/db";
import { and, desc, eq } from "drizzle-orm";
import { hashRecipientIdentifier } from "./contact-consent";

export const MAX_CONVERSATION_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinConversationReplyWindow(
	lastInboundAt: Date,
	now = new Date(),
	providerWindowMs = MAX_CONVERSATION_REPLY_WINDOW_MS,
): boolean {
	const effectiveWindow = Math.min(
		MAX_CONVERSATION_REPLY_WINDOW_MS,
		Math.max(0, providerWindowMs),
	);
	const elapsed = now.getTime() - lastInboundAt.getTime();
	return elapsed >= 0 && elapsed <= effectiveWindow;
}

/**
 * Authorize a customer-service reply from durable conversation history.
 *
 * This capability is intentionally separate from marketing consent: it is
 * opened only by an inbound message on the exact account/workspace tuple,
 * expires after at most 24 hours (or a shorter provider cap), and still honors
 * an exact `service` suppression for the recipient identifier.
 */
export async function authorizeConversationReply(
	db: Database,
	input: {
		organizationId: string;
		scopeKey: string;
		conversationId: string;
		accountId: string;
		platform: typeof inboxMessages.$inferSelect.platform;
		recipientIdentifier: string;
		now?: Date;
		providerWindowMs?: number;
	},
): Promise<
	| { authorized: true; lastInboundAt: Date; expiresAt: Date }
	| { authorized: false; reason: "suppressed" | "no_inbound" | "expired" }
> {
	const identifierHash = await hashRecipientIdentifier(
		input.platform,
		input.recipientIdentifier,
	);
	const [suppressionRows, inboundRows] = await Promise.all([
		db
			.select({ id: contactSuppressions.id })
			.from(contactSuppressions)
			.where(
				and(
					eq(contactSuppressions.organizationId, input.organizationId),
					eq(contactSuppressions.channel, input.platform),
					eq(contactSuppressions.purpose, "service"),
					eq(contactSuppressions.identifierHash, identifierHash),
				),
			)
			.limit(1),
		db
			.select({ createdAt: inboxMessages.createdAt })
			.from(inboxMessages)
			.where(
				and(
					eq(inboxMessages.organizationId, input.organizationId),
					eq(inboxMessages.scopeKey, input.scopeKey),
					eq(inboxMessages.conversationId, input.conversationId),
					eq(inboxMessages.accountId, input.accountId),
					eq(inboxMessages.platform, input.platform),
					eq(inboxMessages.direction, "inbound"),
				),
			)
			.orderBy(desc(inboxMessages.createdAt), desc(inboxMessages.id))
			.limit(1),
	]);

	if (suppressionRows.length > 0) {
		return { authorized: false, reason: "suppressed" };
	}
	const lastInboundAt = inboundRows[0]?.createdAt;
	if (!lastInboundAt) return { authorized: false, reason: "no_inbound" };

	const now = input.now ?? new Date();
	const effectiveWindow = Math.min(
		MAX_CONVERSATION_REPLY_WINDOW_MS,
		Math.max(0, input.providerWindowMs ?? MAX_CONVERSATION_REPLY_WINDOW_MS),
	);
	if (!isWithinConversationReplyWindow(lastInboundAt, now, effectiveWindow)) {
		return { authorized: false, reason: "expired" };
	}
	return {
		authorized: true,
		lastInboundAt,
		expiresAt: new Date(lastInboundAt.getTime() + effectiveWindow),
	};
}
