/**
 * Instagram automation node handlers.
 *
 * Messaging (DMs) uses the Instagram Messaging API:
 *   POST {GRAPH_BASE.instagram}/{ig-user-id}/messages
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 *
 * Comment operations use the Graph API:
 *   Reply to comment:  POST {GRAPH_BASE.instagram}/{comment-id}/replies
 *   Hide comment:      POST {GRAPH_BASE.instagram}/{comment-id}   body: { hide: true }
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content
 *
 * Sender action (typing_on | typing_off | mark_seen) uses the messages endpoint:
 *   POST {GRAPH_BASE.instagram}/{ig-user-id}/messages
 *   body: { recipient: { id }, sender_action }
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/sender-actions
 */

import { contactChannels, contacts, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { GRAPH_BASE } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

interface InstagramSendCtx {
	accessToken: string;
	igUserId: string;
	recipientIgsid: string;
	contact: Record<string, unknown> | null;
	state: Record<string, unknown>;
}

async function loadDmContext(
	ctx: NodeExecutionContext,
): Promise<InstagramSendCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };

	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "instagram account not found or missing token" };

	const chan = await ctx.db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, ctx.enrollment.contact_id),
			eq(contactChannels.platform, "instagram"),
		),
	});
	if (!chan) return { kind: "fail", error: "contact has no instagram channel identifier" };

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});

	const accessToken = await decryptToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY,
	);

	return {
		accessToken,
		igUserId: account.platformAccountId,
		recipientIgsid: chan.identifier,
		contact: (contact as unknown as Record<string, unknown>) ?? null,
		state: ctx.enrollment.state,
	};
}

async function loadTokenOnly(
	ctx: NodeExecutionContext,
): Promise<{ accessToken: string } | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "instagram account not found or missing token" };
	const accessToken = await decryptToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY,
	);
	return { accessToken };
}

async function postMessage(
	accessToken: string,
	igUserId: string,
	body: Record<string, unknown>,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.instagram}/${igUserId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} from Instagram messages API`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { message_id?: string };
	return {
		kind: "next",
		state_patch: { last_message_id: data.message_id },
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

function renderTemplate(
	template: string | undefined,
	dm: InstagramSendCtx,
): string {
	if (!template) return "";
	return applyMergeTags(template, { contact: dm.contact, state: dm.state });
}

// ---------------------------------------------------------------------------
// Text DM  — instagram_send_text
// ---------------------------------------------------------------------------

export const instagramSendTextHandler: NodeHandler = async (ctx) => {
	const textTemplate = ctx.node.config.text as string | undefined;
	if (!textTemplate) return { kind: "fail", error: "instagram_send_text missing 'text'" };

	const setup = await loadDmContext(ctx);
	if (isFailResult(setup)) return setup;

	return postMessage(setup.accessToken, setup.igUserId, {
		recipient: { id: setup.recipientIgsid },
		message: { text: renderTemplate(textTemplate, setup) },
	});
};

// ---------------------------------------------------------------------------
// Media DM — instagram_send_media
// Instagram Login supports: image, video, audio via `attachment.type`.
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api#media-message
// ---------------------------------------------------------------------------

export const instagramSendMediaHandler: NodeHandler = async (ctx) => {
	const url = ctx.node.config.url as string | undefined;
	const mediaType = (ctx.node.config.media_type as string | undefined) ?? "image";
	if (!url) return { kind: "fail", error: "instagram_send_media missing 'url'" };

	const setup = await loadDmContext(ctx);
	if (isFailResult(setup)) return setup;

	return postMessage(setup.accessToken, setup.igUserId, {
		recipient: { id: setup.recipientIgsid },
		message: {
			attachment: {
				type: mediaType,
				payload: { url },
			},
		},
	});
};

// ---------------------------------------------------------------------------
// Quick replies — instagram_send_quick_replies
// ---------------------------------------------------------------------------

export const instagramSendQuickRepliesHandler: NodeHandler = async (ctx) => {
	const textTemplate = ctx.node.config.text as string | undefined;
	const replies = ctx.node.config.quick_replies as
		| Array<{ title: string; payload?: string }>
		| undefined;
	if (!textTemplate)
		return { kind: "fail", error: "instagram_send_quick_replies missing 'text'" };
	if (!replies || replies.length === 0)
		return { kind: "fail", error: "instagram_send_quick_replies missing 'quick_replies'" };

	const setup = await loadDmContext(ctx);
	if (isFailResult(setup)) return setup;

	return postMessage(setup.accessToken, setup.igUserId, {
		recipient: { id: setup.recipientIgsid },
		message: {
			text: renderTemplate(textTemplate, setup),
			quick_replies: replies.map((r) => ({
				content_type: "text",
				title: r.title,
				payload: r.payload ?? r.title,
			})),
		},
	});
};

// ---------------------------------------------------------------------------
// Button template — instagram_send_buttons
// Uses the generic button template: up to 3 postback/web URL buttons.
// ---------------------------------------------------------------------------

export const instagramSendButtonsHandler: NodeHandler = async (ctx) => {
	const textTemplate = ctx.node.config.text as string | undefined;
	const buttons = ctx.node.config.buttons as
		| Array<{ type: "postback" | "web_url"; title: string; payload?: string; url?: string }>
		| undefined;
	if (!textTemplate)
		return { kind: "fail", error: "instagram_send_buttons missing 'text'" };
	if (!buttons || buttons.length === 0)
		return { kind: "fail", error: "instagram_send_buttons missing 'buttons'" };

	const setup = await loadDmContext(ctx);
	if (isFailResult(setup)) return setup;

	return postMessage(setup.accessToken, setup.igUserId, {
		recipient: { id: setup.recipientIgsid },
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "button",
					text: renderTemplate(textTemplate, setup),
					buttons: buttons.slice(0, 3).map((b) =>
						b.type === "web_url"
							? { type: "web_url", url: b.url, title: b.title }
							: { type: "postback", title: b.title, payload: b.payload ?? b.title },
					),
				},
			},
		},
	});
};

// ---------------------------------------------------------------------------
// Generic template — instagram_send_generic_template
// Up to 10 elements, each with title/subtitle/image/buttons.
// ---------------------------------------------------------------------------

export const instagramSendGenericTemplateHandler: NodeHandler = async (ctx) => {
	const elements = ctx.node.config.elements as
		| Array<{
				title: string;
				subtitle?: string;
				image_url?: string;
				buttons?: Array<{
					type: "postback" | "web_url";
					title: string;
					payload?: string;
					url?: string;
				}>;
		  }>
		| undefined;
	if (!elements || elements.length === 0)
		return { kind: "fail", error: "instagram_send_generic_template missing 'elements'" };

	const setup = await loadDmContext(ctx);
	if (isFailResult(setup)) return setup;

	return postMessage(setup.accessToken, setup.igUserId, {
		recipient: { id: setup.recipientIgsid },
		message: {
			attachment: {
				type: "template",
				payload: {
					template_type: "generic",
					elements: elements.slice(0, 10).map((el) => ({
						title: el.title,
						subtitle: el.subtitle,
						image_url: el.image_url,
						buttons: el.buttons?.map((b) =>
							b.type === "web_url"
								? { type: "web_url", url: b.url, title: b.title }
								: { type: "postback", title: b.title, payload: b.payload ?? b.title },
						),
					})),
				},
			},
		},
	});
};

// ---------------------------------------------------------------------------
// Sender actions — instagram_typing (on/off) + instagram_mark_seen
// ---------------------------------------------------------------------------

function senderActionHandler(action: "typing_on" | "typing_off" | "mark_seen"): NodeHandler {
	return async (ctx) => {
		const setup = await loadDmContext(ctx);
		if (isFailResult(setup)) return setup;
		const res = await fetchWithTimeout(
			`${GRAPH_BASE.instagram}/${setup.igUserId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${setup.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					recipient: { id: setup.recipientIgsid },
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
				error: err.error?.message ?? `HTTP ${res.status} on sender_action=${action}`,
			};
		}
		return { kind: "next" };
	};
}

export const instagramTypingHandler: NodeHandler = async (ctx) => {
	const off = (ctx.node.config.off as boolean | undefined) ?? false;
	return senderActionHandler(off ? "typing_off" : "typing_on")(ctx);
};

export const instagramMarkSeenHandler: NodeHandler = senderActionHandler("mark_seen");

// ---------------------------------------------------------------------------
// Reply to comment — instagram_reply_to_comment
// The comment_id comes from the enrollment state (the trigger payload stored it).
// ---------------------------------------------------------------------------

export const instagramReplyToCommentHandler: NodeHandler = async (ctx) => {
	const textTemplate = ctx.node.config.text as string | undefined;
	if (!textTemplate)
		return { kind: "fail", error: "instagram_reply_to_comment missing 'text'" };

	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	if (!commentId)
		return {
			kind: "fail",
			error: "no comment_id on node config or enrollment state",
		};

	const setup = await loadTokenOnly(ctx);
	if (isFailResult(setup)) return setup;

	// Merge tags rendered against contact + state when available
	const contactId = ctx.enrollment.contact_id;
	let contact: Record<string, unknown> | null = null;
	if (contactId) {
		const row = await ctx.db.query.contacts.findFirst({
			where: eq(contacts.id, contactId),
		});
		contact = (row as unknown as Record<string, unknown>) ?? null;
	}
	const message = applyMergeTags(textTemplate, {
		contact,
		state: ctx.enrollment.state,
	});

	const res = await fetchWithTimeout(
		`${GRAPH_BASE.instagram}/${commentId}/replies`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
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
			error: err.error?.message ?? `HTTP ${res.status} replying to comment ${commentId}`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return {
		kind: "next",
		state_patch: { last_reply_id: data.id },
	};
};

// ---------------------------------------------------------------------------
// Hide comment — instagram_hide_comment
// ---------------------------------------------------------------------------

export const instagramHideCommentHandler: NodeHandler = async (ctx) => {
	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	if (!commentId)
		return {
			kind: "fail",
			error: "no comment_id on node config or enrollment state",
		};

	const setup = await loadTokenOnly(ctx);
	if (isFailResult(setup)) return setup;

	const res = await fetchWithTimeout(
		`${GRAPH_BASE.instagram}/${commentId}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hide: true }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} hiding comment ${commentId}`,
		};
	}
	return { kind: "next" };
};
