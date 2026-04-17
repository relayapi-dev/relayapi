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

export interface SendMessageRequest {
	platform: string;
	accessToken: string;
	platformAccountId: string;
	recipientId: string;
	text: string;
	// WhatsApp template fields
	templateName?: string;
	templateLanguage?: string;
	templateComponents?: unknown[];
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
		default:
			return {
				success: false,
				error: `Direct messaging not supported for platform: ${request.platform}`,
			};
	}
}

async function sendWhatsApp(req: SendMessageRequest): Promise<SendMessageResult> {
	const body = req.templateName
		? {
				messaging_product: "whatsapp",
				to: req.recipientId,
				type: "template",
				template: {
					name: req.templateName,
					language: { code: req.templateLanguage ?? "en_US" },
					components: req.templateComponents ?? [],
				},
			}
		: {
				messaging_product: "whatsapp",
				to: req.recipientId,
				type: "text",
				text: { body: req.text },
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

	const data = (await res.json()) as { messages?: Array<{ id: string }> };
	return { success: true, messageId: data.messages?.[0]?.id };
}

async function sendTelegram(req: SendMessageRequest): Promise<SendMessageResult> {
	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${req.accessToken}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: req.recipientId,
				text: req.text,
			}),
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
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.instagram}/${req.platformAccountId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				recipient: { id: req.recipientId },
				message: { text: req.text },
			}),
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
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${req.platformAccountId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${req.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				recipient: { id: req.recipientId },
				messaging_type: "UPDATE",
				message: { text: req.text },
			}),
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
