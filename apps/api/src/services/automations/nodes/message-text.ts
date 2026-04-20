import { contacts, contactChannels, socialAccounts } from "@relayapi/db";
import { eq, and } from "drizzle-orm";
import { decryptToken } from "../../../lib/crypto";
import { sendMessage } from "../../message-sender";
import { findScopedContactChannel } from "../contact-channel";
import { applyMergeTags } from "../merge-tags";
import type { NodeHandler } from "../types";

/**
 * Sends a plain text DM on whatever channel the automation is configured for.
 * Resolves recipient identifier via contactChannels, access token via socialAccounts.
 */
export const messageTextHandler: NodeHandler = async (ctx) => {
	const textTemplate = ctx.node.config.text as string | undefined;
	if (!textTemplate) {
		return { kind: "fail", error: "message_text missing 'text'" };
	}
	const recipientMode =
		(ctx.node.config.recipient_mode as string | undefined) ?? "enrolled_contact";
	const recipientTemplate = ctx.node.config.recipient_identifier as
		| string
		| undefined;

	const channel = ctx.snapshot.channel;
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) {
		return { kind: "fail", error: "automation has no social account bound" };
	}

	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken) {
		return { kind: "fail", error: "social account not found or has no token" };
	}

	const accessToken = await decryptToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY,
	);

	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;
	if (ctx.enrollment.contact_id && !contact) {
		return { kind: "fail", error: "contact not found" };
	}

	const text = applyMergeTags(textTemplate, {
		contact: contact as unknown as Record<string, unknown>,
		state: ctx.enrollment.state,
	});
	let recipientId: string | null = null;

	if (recipientMode === "custom_identifier" || recipientTemplate) {
		const resolved = applyMergeTags(recipientTemplate ?? "", {
			contact: contact as unknown as Record<string, unknown>,
			state: ctx.enrollment.state,
		}).trim();
		if (!resolved) {
			return {
				kind: "fail",
				error:
					"message_text custom recipient_identifier resolved to an empty value",
			};
		}
		recipientId = resolved;
	} else {
		if (!ctx.enrollment.contact_id) {
			return {
				kind: "fail",
				error:
					"message_text needs an enrolled contact or a custom recipient_identifier",
			};
		}

		const chan = await findScopedContactChannel(ctx.db, {
			contactId: ctx.enrollment.contact_id,
			platform: channel,
			socialAccountId: accountId,
		});
		if (!chan) {
			return {
				kind: "fail",
				error: `contact has no ${channel} channel identifier for this account`,
			};
		}
		recipientId = chan.identifier;
	}

	const result = await sendMessage({
		platform: channel,
		accessToken,
		platformAccountId: account.platformAccountId,
		recipientId,
		text,
	});

	if (!result.success) {
		return { kind: "fail", error: result.error ?? "send failed" };
	}

	return {
		kind: "next",
		state_patch: {
			last_message_id: result.messageId,
			last_recipient_id: recipientId,
		},
	};
};
