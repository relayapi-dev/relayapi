/**
 * Facebook Messenger automation node handlers.
 *
 * Send API:    POST {GRAPH_BASE.facebook}/{page-id}/messages
 *    Docs:     https://developers.facebook.com/docs/messenger-platform/reference/send-api/
 *    Format:   { recipient: { id }, messaging_type: "RESPONSE"|"UPDATE"|"MESSAGE_TAG",
 *                message: { text } | { attachment: {...} } }
 *
 * Comment ops via Graph API:
 *    Reply/Hide on a comment:  POST {GRAPH_BASE.facebook}/{comment-id}  { message | is_hidden }
 *    Private reply:            POST {GRAPH_BASE.facebook}/{page-id}/messages
 *                              { recipient: { comment_id }, message: { text } }
 *
 * Sender action: POST {GRAPH_BASE.facebook}/{page-id}/messages
 *                { recipient: { id }, sender_action: "typing_on"|"typing_off"|"mark_seen" }
 *
 * NOTE (from audit): the `HUMAN_AGENT` tag is for human reply surfaces, not an
 * automation escape hatch. Stay inside the 24h window for automated sends.
 */

import { contacts, socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { GRAPH_BASE } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { findScopedContactChannel } from "../../contact-channel";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface FbCtx {
	accessToken: string;
	pageId: string;
	recipientPsid: string;
	contact: Record<string, unknown> | null;
	state: Record<string, unknown>;
}

async function loadDmCtx(
	ctx: NodeExecutionContext,
): Promise<FbCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "facebook account not found or missing token" };
	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: "facebook",
		socialAccountId: accountId,
	});
	if (!chan)
		return {
			kind: "fail",
			error: "contact has no facebook PSID for this account",
		};
	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		pageId: account.platformAccountId,
		recipientPsid: chan.identifier,
		contact: (contact as unknown as Record<string, unknown>) ?? null,
		state: ctx.enrollment.state,
	};
}

async function loadPageCtx(
	ctx: NodeExecutionContext,
): Promise<{ accessToken: string; pageId: string } | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "facebook account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return { accessToken, pageId: account.platformAccountId };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function postMessage(
	c: FbCtx,
	message: Record<string, unknown>,
	messagingType: string = "RESPONSE",
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${c.pageId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${c.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				recipient: { id: c.recipientPsid },
				messaging_type: messagingType,
				message,
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} from facebook send API`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { message_id?: string };
	return { kind: "next", state_patch: { last_message_id: data.message_id } };
}

function render(template: string | undefined, c: FbCtx): string {
	if (!template) return "";
	return applyMergeTags(template, { contact: c.contact, state: c.state });
}

// ---------------------------------------------------------------------------

export const facebookSendTextHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "facebook_send_text missing 'text'" };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	return postMessage(setup, { text: render(text, setup) });
};

export const facebookSendMediaHandler: NodeHandler = async (ctx) => {
	const url = ctx.node.config.url as string | undefined;
	const mediaType = (ctx.node.config.media_type as string | undefined) ?? "image";
	if (!url) return { kind: "fail", error: "facebook_send_media missing 'url'" };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	return postMessage(setup, {
		attachment: {
			type: mediaType,
			payload: { url, is_reusable: true },
		},
	});
};

export const facebookSendTemplateHandler: NodeHandler = async (ctx) => {
	const payload = ctx.node.config.payload as Record<string, unknown> | undefined;
	if (!payload)
		return { kind: "fail", error: "facebook_send_template missing 'payload'" };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	return postMessage(setup, {
		attachment: { type: "template", payload },
	});
};

export const facebookSendQuickRepliesHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const replies = ctx.node.config.quick_replies as
		| Array<{ title: string; payload?: string }>
		| undefined;
	if (!text)
		return { kind: "fail", error: "facebook_send_quick_replies missing 'text'" };
	if (!replies || replies.length === 0)
		return { kind: "fail", error: "facebook_send_quick_replies missing 'quick_replies'" };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	return postMessage(setup, {
		text: render(text, setup),
		quick_replies: replies.map((r) => ({
			content_type: "text",
			title: r.title,
			payload: r.payload ?? r.title,
		})),
	});
};

export const facebookSendButtonTemplateHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const buttons = ctx.node.config.buttons as
		| Array<{
				type: "postback" | "web_url";
				title: string;
				payload?: string;
				url?: string;
		  }>
		| undefined;
	if (!text) return { kind: "fail", error: "facebook_send_button_template missing 'text'" };
	if (!buttons || buttons.length === 0)
		return { kind: "fail", error: "facebook_send_button_template missing 'buttons'" };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	return postMessage(setup, {
		attachment: {
			type: "template",
			payload: {
				template_type: "button",
				text: render(text, setup),
				buttons: buttons.slice(0, 3).map((b) =>
					b.type === "web_url"
						? { type: "web_url", url: b.url, title: b.title }
						: { type: "postback", title: b.title, payload: b.payload ?? b.title },
				),
			},
		},
	});
};

export const facebookReplyToCommentHandler: NodeHandler = async (ctx) => {
	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	const message = ctx.node.config.message as string | undefined;
	if (!commentId || !message)
		return {
			kind: "fail",
			error: "facebook_reply_to_comment needs comment_id + message",
		};
	const pc = await loadPageCtx(ctx);
	if (isFailResult(pc)) return pc;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${commentId}/comments`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${pc.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ message }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} replying to FB comment`,
		};
	}
	return { kind: "next" };
};

export const facebookPrivateReplyHandler: NodeHandler = async (ctx) => {
	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	const text = ctx.node.config.text as string | undefined;
	if (!commentId || !text)
		return {
			kind: "fail",
			error: "facebook_private_reply needs comment_id + text",
		};
	const pc = await loadPageCtx(ctx);
	if (isFailResult(pc)) return pc;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${pc.pageId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${pc.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				recipient: { comment_id: commentId },
				message: { text },
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} sending private reply`,
		};
	}
	return { kind: "next" };
};

export const facebookHideCommentHandler: NodeHandler = async (ctx) => {
	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	if (!commentId)
		return { kind: "fail", error: "facebook_hide_comment needs comment_id" };
	const pc = await loadPageCtx(ctx);
	if (isFailResult(pc)) return pc;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${commentId}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${pc.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ is_hidden: true }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} hiding FB comment`,
		};
	}
	return { kind: "next" };
};

export const facebookSenderActionHandler: NodeHandler = async (ctx) => {
	const action = (ctx.node.config.action as string | undefined) ?? "typing_on";
	if (!["typing_on", "typing_off", "mark_seen"].includes(action))
		return { kind: "fail", error: `facebook_sender_action unknown action '${action}'` };
	const setup = await loadDmCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${setup.pageId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				recipient: { id: setup.recipientPsid },
				sender_action: action,
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} on sender_action`,
		};
	}
	return { kind: "next" };
};
