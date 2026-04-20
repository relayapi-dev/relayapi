import { contacts, socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../lib/crypto";
import { sendMessage } from "../../message-sender";
import { findScopedContactChannel } from "../contact-channel";
import { applyMergeTags } from "../merge-tags";
import type { NodeExecutionContext, NodeHandler } from "../types";

/**
 * Sends the prompt text via the channel, then parks the enrollment in
 * 'waiting' state with `_pending_input_*` markers. When the next inbound
 * message from the contact arrives, inbox-event-processor routes it to
 * `resumeFromInput()` which validates the value, optionally retries (re-sends
 * `retry_prompt`), and either resumes via `captured` or falls through to
 * `no_match` when attempts are exhausted.
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

	const sent = await sendInputPrompt(ctx, promptTemplate);
	if (!sent.ok) return { kind: "fail", error: sent.error };

	const timeoutMin = ctx.node.config.timeout_minutes as number | undefined;
	const patch: Record<string, unknown> = {
		_pending_input_field: saveToField,
		_pending_input_node_key: ctx.node.key,
		_pending_input_node_type: ctx.node.type,
		_pending_input_channel: ctx.snapshot.channel,
		_pending_input_conversation_id: ctx.enrollment.conversation_id ?? null,
		_pending_input_attempts: 0,
	};
	if (timeoutMin) {
		patch._pending_input_timeout_at = new Date(
			Date.now() + timeoutMin * 60 * 1000,
		).toISOString();
	}

	return { kind: "wait_for_input", state_patch: patch };
};

/**
 * Send a templated message (prompt or retry_prompt) to the contact on the
 * automation's channel. Exported so `resumeFromInput()` can re-send the
 * retry prompt when input fails validation.
 */
export async function sendInputPrompt(
	ctx: Pick<NodeExecutionContext, "env" | "db" | "snapshot" | "enrollment">,
	template: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const channel = ctx.snapshot.channel;
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) {
		return { ok: false, error: "automation has no social account bound" };
	}
	if (!ctx.enrollment.contact_id) {
		return { ok: false, error: "enrollment has no contact_id" };
	}

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});
	if (!contact) return { ok: false, error: "contact not found" };

	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: channel,
		socialAccountId: accountId,
	});
	if (!chan) {
		return {
			ok: false,
			error: `contact has no ${channel} channel identifier for this account`,
		};
	}

	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken) {
		return { ok: false, error: "social account not found or has no token" };
	}

	const accessToken = await decryptToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY,
	);

	const text = applyMergeTags(template, {
		contact: contact as unknown as Record<string, unknown>,
		state: ctx.enrollment.state,
	});

	const result = await sendMessage({
		platform: channel,
		accessToken,
		platformAccountId: account.platformAccountId,
		recipientId: chan.identifier,
		text,
	});
	if (!result.success) {
		return {
			ok: false,
			error: result.error ?? "user_input prompt send failed",
		};
	}
	return { ok: true };
}
