import { contactChannels, contacts, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { decryptToken } from "../../../lib/crypto";
import { sendMessage } from "../../message-sender";
import { applyMergeTags } from "../merge-tags";
import type { NodeHandler } from "../types";

/**
 * Sends the prompt text via the channel, then parks the enrollment in
 * 'waiting' state with `_pending_input_*` markers. When the next inbound
 * message from the contact arrives, inbox-event-processor routes it to
 * `resumeFromInput()` which captures the value and advances the graph.
 *
 * The captured value validation + retry loop against `no_match` is wired in
 * a follow-up per input subtype.
 */
export const userInputHandler: NodeHandler = async (ctx) => {
	const saveToField = ctx.node.config.save_to_field as string | undefined;
	const promptTemplate = ctx.node.config.prompt as string | undefined;
	if (!saveToField) {
		return { kind: "fail", error: "user_input missing 'save_to_field'" };
	}
	if (!promptTemplate) {
		return { kind: "fail", error: "user_input missing 'prompt'" };
	}

	const channel = ctx.snapshot.channel;
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) {
		return { kind: "fail", error: "automation has no social account bound" };
	}
	if (!ctx.enrollment.contact_id) {
		return { kind: "fail", error: "enrollment has no contact_id" };
	}

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});
	if (!contact) return { kind: "fail", error: "contact not found" };

	const chan = await ctx.db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, ctx.enrollment.contact_id),
			eq(contactChannels.platform, channel),
		),
	});
	if (!chan) {
		return {
			kind: "fail",
			error: `contact has no ${channel} channel identifier`,
		};
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

	const prompt = applyMergeTags(promptTemplate, {
		contact: contact as unknown as Record<string, unknown>,
		state: ctx.enrollment.state,
	});

	const sendResult = await sendMessage({
		platform: channel,
		accessToken,
		platformAccountId: account.platformAccountId,
		recipientId: chan.identifier,
		text: prompt,
	});
	if (!sendResult.success) {
		return {
			kind: "fail",
			error: sendResult.error ?? "user_input prompt send failed",
		};
	}

	const timeoutMin = ctx.node.config.timeout_minutes as number | undefined;
	const patch: Record<string, unknown> = {
		_pending_input_field: saveToField,
		_pending_input_node_key: ctx.node.key,
		_pending_input_channel: channel,
		_pending_input_conversation_id: ctx.enrollment.conversation_id ?? null,
	};
	if (timeoutMin) {
		patch._pending_input_timeout_at = new Date(
			Date.now() + timeoutMin * 60 * 1000,
		).toISOString();
	}

	return { kind: "wait_for_input", state_patch: patch };
};
