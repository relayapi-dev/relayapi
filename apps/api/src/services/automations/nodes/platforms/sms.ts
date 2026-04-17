/**
 * SMS automation node handlers.
 *
 * Provider-abstracted via a `provider` field on the socialAccount's metadata
 * (defaults to "twilio"). Supports Twilio and Telnyx.
 *
 * Twilio: https://www.twilio.com/docs/sms/api
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Auth: Basic base64(AccountSid:AuthToken)
 *
 * Telnyx: https://developers.telnyx.com/docs/messaging/send-messages
 *   POST https://api.telnyx.com/v2/messages
 *   Auth: Bearer {api_key}
 */

import { contactChannels, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface SmsCtx {
	provider: "twilio" | "telnyx";
	accessToken: string; // Twilio auth token OR Telnyx api key
	fromPhone: string;
	platformAccountId: string; // Twilio Account SID (ignored for telnyx)
	recipient: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<SmsCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "sms account not found or missing token" };
	const chan = await ctx.db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, ctx.enrollment.contact_id),
			eq(contactChannels.platform, "sms"),
		),
	});
	if (!chan) return { kind: "fail", error: "contact has no sms phone number" };
	const meta = (account.metadata as Record<string, unknown> | null) ?? {};
	const provider = (meta.provider as "twilio" | "telnyx" | undefined) ?? "twilio";
	const fromPhone =
		(meta.from_phone as string | undefined) ?? account.username ?? "";
	if (!fromPhone)
		return { kind: "fail", error: "sms account has no from phone number" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		provider,
		accessToken,
		fromPhone,
		platformAccountId: account.platformAccountId,
		recipient: chan.identifier,
		state: ctx.enrollment.state,
	};
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function sendTwilio(
	c: SmsCtx,
	text: string,
	mediaUrl: string | undefined,
): Promise<NodeExecutionResult> {
	const auth = btoa(`${c.platformAccountId}:${c.accessToken}`);
	const form = new URLSearchParams({
		From: c.fromPhone,
		To: c.recipient,
		Body: text,
	});
	if (mediaUrl) form.append("MediaUrl", mediaUrl);
	const res = await fetchWithTimeout(
		`https://api.twilio.com/2010-04-01/Accounts/${c.platformAccountId}/Messages.json`,
		{
			method: "POST",
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: form.toString(),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from twilio` };
	}
	const data = (await res.json().catch(() => ({}))) as { sid?: string };
	return { kind: "next", state_patch: { last_message_id: data.sid } };
}

async function sendTelnyx(
	c: SmsCtx,
	text: string,
	mediaUrl: string | undefined,
): Promise<NodeExecutionResult> {
	const body: Record<string, unknown> = {
		from: c.fromPhone,
		to: c.recipient,
		text,
	};
	if (mediaUrl) body.media_urls = [mediaUrl];
	const res = await fetchWithTimeout("https://api.telnyx.com/v2/messages", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${c.accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			errors?: Array<{ detail?: string }>;
		};
		return {
			kind: "fail",
			error: err.errors?.[0]?.detail ?? `HTTP ${res.status} from telnyx`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as {
		data?: { id?: string };
	};
	return { kind: "next", state_patch: { last_message_id: data.data?.id } };
}

export const smsSendHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "sms_send missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const rendered = applyMergeTags(text, { state: setup.state });
	return setup.provider === "telnyx"
		? sendTelnyx(setup, rendered, undefined)
		: sendTwilio(setup, rendered, undefined);
};

export const smsSendMmsHandler: NodeHandler = async (ctx) => {
	const text = (ctx.node.config.text as string | undefined) ?? "";
	const url = ctx.node.config.media_url as string | undefined;
	if (!url) return { kind: "fail", error: "sms_send_mms missing 'media_url'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const rendered = applyMergeTags(text, { state: setup.state });
	return setup.provider === "telnyx"
		? sendTelnyx(setup, rendered, url)
		: sendTwilio(setup, rendered, url);
};
