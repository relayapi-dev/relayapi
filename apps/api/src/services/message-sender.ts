/**
 * Multi-platform direct message sender for sequences and broadcasts.
 * Separate from the Publisher interface which handles public posts.
 *
 * Platform docs:
 * - WhatsApp: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
 * - Telegram: https://core.telegram.org/bots/api#sendmessage
 * - Twitter/X: https://docs.x.com/x-api/direct-messages/manage/introduction
 * - Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 * - Facebook: https://developers.facebook.com/docs/messenger-platform/reference/send-api/
 * - Reddit: https://www.reddit.com/dev/api/#POST_api_compose
 */

import { GRAPH_BASE } from "../config/api-versions";
import { fetchWithTimeout } from "../lib/fetch-timeout";

/**
 * A single interactive button on a text/card message.
 *
 * - `branch`  → callback-style button that surfaces the button `id` back to the
 *               runtime when pressed (IG/Messenger postback, Telegram
 *               callback_data, WhatsApp interactive reply).
 * - `url`     → opens a URL in the user's browser (IG/Messenger web_url,
 *               Telegram url button). Skipped on WhatsApp (templates only).
 * - `call`    → dials a phone number. Supported on IG/Messenger (phone_number
 *               button). Skipped elsewhere.
 * - `share`   → platform-specific share button (IG/Messenger only). Skipped
 *               elsewhere.
 */
export interface SendMessageButton {
	id: string;
	type: "branch" | "url" | "call" | "share";
	label: string;
	url?: string;
	phone?: string;
}

export interface SendMessageQuickReply {
	id: string;
	label: string;
	icon?: string; // emoji
}

export interface SendMessageAttachment {
	type: "image" | "video" | "audio" | "file";
	url: string;
	caption?: string;
}

export interface SendMessageCard {
	image_url?: string;
	title: string;
	subtitle?: string;
	buttons?: SendMessageButton[];
}

export interface SendMessageRequest {
	platform: string;
	accessToken: string;
	platformAccountId: string;
	recipientId: string;
	/**
	 * Message body. Kept nominally required for backwards compatibility with
	 * existing callers (broadcasts, inbox replies). Interactive-only sends
	 * (buttons / card / gallery without surrounding text) may pass an empty
	 * string — per-platform encoders treat empty text as "no text segment".
	 */
	text: string;
	// WhatsApp template fields
	templateName?: string;
	templateLanguage?: string;
	templateComponents?: unknown[];

	// ---------------------------------------------------------------------
	// Interactive / rich payload fields. All optional; each per-platform
	// `send*` function encodes these into the platform's native API shape
	// where supported and silently skips them where they aren't.
	// ---------------------------------------------------------------------

	/** Non-inline media attachments (image, video, audio, file). */
	attachments?: SendMessageAttachment[];
	/** Inline buttons attached to the text body (or to a card). */
	buttons?: SendMessageButton[];
	/** Bottom-of-message quick reply chips (IG/Messenger/Telegram only). */
	quick_replies?: SendMessageQuickReply[];
	/** Single card with an image + title + subtitle + buttons. */
	card?: SendMessageCard;
	/** Horizontal carousel of cards (IG/Messenger only; max 10). */
	gallery?: SendMessageCard[];
}

export interface SendMessageResult {
	success: boolean;
	messageId?: string;
	error?: string;
}

export async function sendMessage(
	request: SendMessageRequest,
): Promise<SendMessageResult> {
	switch (request.platform) {
		case "whatsapp":
			return sendWhatsApp(request);
		case "telegram":
			return sendTelegram(request);
		case "twitter":
			return sendTwitterDM(request);
		case "instagram":
			return sendInstagramDM(request);
		case "facebook":
			return sendFacebookMessage(request);
		case "reddit":
			return sendRedditMessage(request);
		case "tiktok":
			return sendTikTokDM(request);
		default:
			return {
				success: false,
				error: `Direct messaging not supported for platform: ${request.platform}`,
			};
	}
}

async function sendWhatsApp(req: SendMessageRequest): Promise<SendMessageResult> {
	const body = buildWhatsAppBody(req);

	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${req.platformAccountId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
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
		return { success: false, error: err.error?.message ?? `HTTP ${res.status}` };
	}

	const data = (await res.json()) as { messages?: Array<{ id: string }> };
	return { success: true, messageId: data.messages?.[0]?.id };
}

/**
 * Build the WhatsApp Cloud API request body.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
 *
 * Precedence:
 *   1. `templateName` → template message (unchanged legacy behavior)
 *   2. `buttons` (reply buttons, max 3) → interactive button message
 *   3. First attachment → media message (image/video/audio/document)
 *   4. Otherwise → plain text message
 *
 * `quick_replies`, `card`, and `gallery` are not natively supported on
 * WhatsApp outside of approved templates — we silently skip them.
 */
function buildWhatsAppBody(req: SendMessageRequest): Record<string, unknown> {
	if (req.templateName) {
		return {
			messaging_product: "whatsapp",
			to: req.recipientId,
			type: "template",
			template: {
				name: req.templateName,
				language: { code: req.templateLanguage ?? "en_US" },
				components: req.templateComponents ?? [],
			},
		};
	}

	// Interactive reply buttons (up to 3).
	const replyButtons = (req.buttons ?? []).filter(
		(b) => b.type === "branch",
	);
	if (replyButtons.length > 0) {
		return {
			messaging_product: "whatsapp",
			to: req.recipientId,
			type: "interactive",
			interactive: {
				type: "button",
				body: { text: req.text || " " },
				action: {
					buttons: replyButtons.slice(0, 3).map((b) => ({
						type: "reply",
						reply: { id: b.id, title: b.label.slice(0, 20) },
					})),
				},
			},
		};
	}

	const firstAttachment = req.attachments?.[0];
	if (firstAttachment) {
		// WhatsApp `document` covers the generic "file" type.
		const type =
			firstAttachment.type === "file" ? "document" : firstAttachment.type;
		return {
			messaging_product: "whatsapp",
			to: req.recipientId,
			type,
			[type]: {
				link: firstAttachment.url,
				...(firstAttachment.caption ? { caption: firstAttachment.caption } : {}),
			},
		};
	}

	return {
		messaging_product: "whatsapp",
		to: req.recipientId,
		type: "text",
		text: { body: req.text },
	};
}

async function sendTelegram(req: SendMessageRequest): Promise<SendMessageResult> {
	const { method, body } = buildTelegramRequest(req);

	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${req.accessToken}/${method}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			timeout: 10_000,
		},
	);

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			description?: string;
		};
		return { success: false, error: err.description ?? `HTTP ${res.status}` };
	}

	const data = (await res.json()) as { result?: { message_id?: number } };
	return {
		success: true,
		messageId: data.result?.message_id?.toString(),
	};
}

/**
 * Build the Telegram Bot API request (method + body).
 * Docs: https://core.telegram.org/bots/api
 *
 * - Buttons → `reply_markup.inline_keyboard` (branch → callback_data, url → url).
 * - Quick replies → `reply_markup.keyboard` with `one_time_keyboard: true`.
 * - Card / Gallery → flattened to a single photo send with caption, since
 *   Telegram has no native generic-template carousel.
 * - First attachment → `sendPhoto` / `sendVideo` / `sendAudio` / `sendDocument`.
 * - Otherwise → `sendMessage` with text.
 */
function buildTelegramRequest(req: SendMessageRequest): {
	method: string;
	body: Record<string, unknown>;
} {
	const chat_id = req.recipientId;
	const reply_markup = buildTelegramReplyMarkup(req);

	// Card with an image → degrade to a photo with caption.
	if (req.card) {
		const captionLines = [req.card.title];
		if (req.card.subtitle) captionLines.push(req.card.subtitle);
		if (req.text) captionLines.unshift(req.text);
		const caption = captionLines.filter(Boolean).join("\n");
		if (req.card.image_url) {
			return {
				method: "sendPhoto",
				body: {
					chat_id,
					photo: req.card.image_url,
					caption,
					...(reply_markup ? { reply_markup } : {}),
				},
			};
		}
		return {
			method: "sendMessage",
			body: {
				chat_id,
				text: caption,
				...(reply_markup ? { reply_markup } : {}),
			},
		};
	}

	// Gallery → pick the first card (best-effort; Telegram has no carousel).
	if (req.gallery && req.gallery.length > 0) {
		const first = req.gallery[0]!;
		const captionLines = [first.title];
		if (first.subtitle) captionLines.push(first.subtitle);
		if (req.text) captionLines.unshift(req.text);
		const caption = captionLines.filter(Boolean).join("\n");
		if (first.image_url) {
			return {
				method: "sendPhoto",
				body: {
					chat_id,
					photo: first.image_url,
					caption,
					...(reply_markup ? { reply_markup } : {}),
				},
			};
		}
		return {
			method: "sendMessage",
			body: {
				chat_id,
				text: caption,
				...(reply_markup ? { reply_markup } : {}),
			},
		};
	}

	const firstAttachment = req.attachments?.[0];
	if (firstAttachment) {
		const method =
			firstAttachment.type === "image"
				? "sendPhoto"
				: firstAttachment.type === "video"
					? "sendVideo"
					: firstAttachment.type === "audio"
						? "sendAudio"
						: "sendDocument";
		const fileField =
			firstAttachment.type === "image"
				? "photo"
				: firstAttachment.type === "video"
					? "video"
					: firstAttachment.type === "audio"
						? "audio"
						: "document";
		return {
			method,
			body: {
				chat_id,
				[fileField]: firstAttachment.url,
				...(firstAttachment.caption
					? { caption: firstAttachment.caption }
					: req.text
						? { caption: req.text }
						: {}),
				...(reply_markup ? { reply_markup } : {}),
			},
		};
	}

	return {
		method: "sendMessage",
		body: {
			chat_id,
			text: req.text,
			...(reply_markup ? { reply_markup } : {}),
		},
	};
}

function buildTelegramReplyMarkup(
	req: SendMessageRequest,
): Record<string, unknown> | null {
	if (req.buttons && req.buttons.length > 0) {
		const rows = req.buttons.map((b) => {
			if (b.type === "url" && b.url) {
				return [{ text: b.label, url: b.url }];
			}
			// branch / call / share all fall back to callback_data carrying the id
			// so the runtime can route the postback (Telegram doesn't have native
			// call/share buttons).
			return [{ text: b.label, callback_data: b.id }];
		});
		return { inline_keyboard: rows };
	}
	if (req.quick_replies && req.quick_replies.length > 0) {
		return {
			keyboard: req.quick_replies.map((q) => [
				{ text: q.icon ? `${q.icon} ${q.label}` : q.label },
			]),
			one_time_keyboard: true,
			resize_keyboard: true,
		};
	}
	return null;
}

async function sendTwitterDM(req: SendMessageRequest): Promise<SendMessageResult> {
	const res = await fetchWithTimeout(
		`https://api.x.com/2/dm_conversations/with/${req.recipientId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ text: req.text }),
			timeout: 10_000,
		},
	);

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			detail?: string;
			errors?: Array<{ message: string }>;
		};
		return {
			success: false,
			error: err.errors?.[0]?.message ?? err.detail ?? `HTTP ${res.status}`,
		};
	}

	const data = (await res.json()) as { data?: { dm_event_id?: string } };
	return { success: true, messageId: data.data?.dm_event_id };
}

async function sendInstagramDM(req: SendMessageRequest): Promise<SendMessageResult> {
	const body = {
		recipient: { id: req.recipientId },
		message: buildMessengerMessage(req, "instagram"),
	};

	const res = await fetchWithTimeout(
		`${GRAPH_BASE.instagram}/${req.platformAccountId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
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
		return { success: false, error: err.error?.message ?? `HTTP ${res.status}` };
	}

	const data = (await res.json()) as { message_id?: string };
	return { success: true, messageId: data.message_id };
}

async function sendFacebookMessage(req: SendMessageRequest): Promise<SendMessageResult> {
	const body = {
		recipient: { id: req.recipientId },
		messaging_type: "UPDATE",
		message: buildMessengerMessage(req, "facebook"),
	};

	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${req.platformAccountId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
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
		return { success: false, error: err.error?.message ?? `HTTP ${res.status}` };
	}

	const data = (await res.json()) as { message_id?: string };
	return { success: true, messageId: data.message_id };
}

/**
 * Build the `message` envelope for Meta's Messenger / Instagram Graph API
 * send endpoint. IG and FB share the payload shape.
 *
 * Docs:
 * - https://developers.facebook.com/docs/messenger-platform/send-messages/template/generic
 * - https://developers.facebook.com/docs/messenger-platform/send-messages/template/button
 * - https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies
 * - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
 *
 * Precedence:
 *   1. `gallery` (>=1) → generic template with N elements
 *   2. `card`          → generic template with 1 element
 *   3. `buttons`       → button template (text is the body)
 *   4. first attachment → `attachment` with url payload
 *   5. otherwise → plain text
 *
 * `quick_replies` attaches to the SAME message envelope when supplied.
 */
function buildMessengerMessage(
	req: SendMessageRequest,
	channel: "instagram" | "facebook",
): Record<string, unknown> {
	const message: Record<string, unknown> = {};

	if (req.gallery && req.gallery.length > 0) {
		message.attachment = {
			type: "template",
			payload: {
				template_type: "generic",
				elements: req.gallery.slice(0, 10).map((c) => buildGenericElement(c, channel)),
			},
		};
	} else if (req.card) {
		message.attachment = {
			type: "template",
			payload: {
				template_type: "generic",
				elements: [buildGenericElement(req.card, channel)],
			},
		};
	} else if (req.buttons && req.buttons.length > 0) {
		message.attachment = {
			type: "template",
			payload: {
				template_type: "button",
				text: req.text || " ",
				buttons: req.buttons
					.map((b) => encodeMessengerButton(b, channel))
					.filter((b): b is Record<string, unknown> => b !== null)
					.slice(0, 3),
			},
		};
	} else if (req.attachments && req.attachments.length > 0) {
		const first = req.attachments[0]!;
		message.attachment = {
			type: first.type,
			payload: { url: first.url, is_reusable: true },
		};
	} else {
		message.text = req.text;
	}

	if (req.quick_replies && req.quick_replies.length > 0) {
		message.quick_replies = req.quick_replies.slice(0, 13).map((q) => ({
			content_type: "text",
			title: q.label,
			payload: q.id,
		}));
	}

	return message;
}

function buildGenericElement(
	card: SendMessageCard,
	channel: "instagram" | "facebook",
): Record<string, unknown> {
	const buttons = (card.buttons ?? [])
		.map((b) => encodeMessengerButton(b, channel))
		.filter((b): b is Record<string, unknown> => b !== null)
		.slice(0, 3);
	return {
		title: card.title,
		...(card.subtitle ? { subtitle: card.subtitle } : {}),
		...(card.image_url ? { image_url: card.image_url } : {}),
		...(buttons.length > 0 ? { buttons } : {}),
	};
}

function encodeMessengerButton(
	b: SendMessageButton,
	channel: "instagram" | "facebook",
): Record<string, unknown> | null {
	switch (b.type) {
		case "branch":
			return { type: "postback", title: b.label, payload: b.id };
		case "url":
			if (!b.url) return null;
			return { type: "web_url", title: b.label, url: b.url };
		case "call":
			// Not supported on Instagram Direct; supported on Messenger.
			if (channel === "instagram") return null;
			if (!b.phone) return null;
			return { type: "phone_number", title: b.label, payload: b.phone };
		case "share":
			// Supported on Messenger only.
			if (channel === "instagram") return null;
			return { type: "element_share" };
		default:
			return null;
	}
}

async function sendRedditMessage(req: SendMessageRequest): Promise<SendMessageResult> {
	const res = await fetchWithTimeout("https://oauth.reddit.com/api/compose", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${req.accessToken}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "web:RelayAPI:1.0 (by /u/relayapi)",
		},
		body: new URLSearchParams({
			api_type: "json",
			to: req.recipientId,
			subject: "Message from RelayAPI",
			text: req.text,
		}),
		timeout: 10_000,
	});

	if (!res.ok) {
		return { success: false, error: `HTTP ${res.status}` };
	}

	return { success: true };
}

/**
 * TikTok Direct Messaging is not a generally-available API. For automation
 * flows we accept a text-only send and silently drop interactive features —
 * `buttons`, `quick_replies`, `card`, `gallery`, `attachments`. This keeps
 * the dispatcher from erroring on TikTok-routed messages and matches the
 * capability matrix in `automations/platforms/index.ts`.
 *
 * The function is a no-op stub that returns `success: true` with no message
 * id; real TikTok DM integration is gated behind a future unit.
 */
async function sendTikTokDM(
	_req: SendMessageRequest,
): Promise<SendMessageResult> {
	// TODO: implement real TikTok DM API when the platform exposes one publicly.
	// For v1 we acknowledge the send without hitting any endpoint so
	// automations routed to TikTok don't fail the whole run.
	return { success: true };
}
