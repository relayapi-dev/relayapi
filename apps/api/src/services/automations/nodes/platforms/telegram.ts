/**
 * Telegram automation node handlers.
 *
 * All methods hit `https://api.telegram.org/bot{token}/{method}`:
 *   sendMessage, sendPhoto/sendVideo/sendDocument, sendMediaGroup,
 *   sendPoll, sendLocation, editMessageText, pinChatMessage, setMessageReaction,
 *   sendChatAction.
 *
 * Docs: https://core.telegram.org/bots/api
 *
 * Bot tokens ARE the credential — the API does not require additional OAuth.
 * The bot token is stored as `accessToken` on the socialAccount.
 * The recipient chat_id is stored as `contactChannels.identifier` for platform='telegram'.
 */

import { contacts, socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { findScopedContactChannel } from "../../contact-channel";
import { applyMergeTags } from "../../merge-tags";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface TelegramCtx {
	botToken: string;
	chatId: string;
	contact: Record<string, unknown> | null;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<TelegramCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };

	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "telegram account not found or missing token" };

	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: "telegram",
		socialAccountId: accountId,
	});
	if (!chan)
		return {
			kind: "fail",
			error: "contact has no telegram chat_id for this account",
		};

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});

	const botToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);

	return {
		botToken,
		chatId: chan.identifier,
		contact: (contact as unknown as Record<string, unknown>) ?? null,
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

async function tgCall(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(
		`https://api.telegram.org/bot${botToken}/${method}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { description?: string };
		return {
			kind: "fail",
			error: err.description ?? `HTTP ${res.status} from telegram ${method}`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as {
		result?: { message_id?: number };
	};
	return {
		kind: "next",
		state_patch: data.result?.message_id
			? { last_message_id: String(data.result.message_id) }
			: undefined,
	};
}

function render(
	template: string | undefined,
	c: TelegramCtx,
): string {
	if (!template) return "";
	return applyMergeTags(template, { contact: c.contact, state: c.state });
}

// ---------------------------------------------------------------------------

export const telegramSendTextHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "telegram_send_text missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "sendMessage", {
		chat_id: setup.chatId,
		text: render(text, setup),
		parse_mode: ctx.node.config.parse_mode,
		disable_web_page_preview: ctx.node.config.disable_web_page_preview,
	});
};

export const telegramSendMediaHandler: NodeHandler = async (ctx) => {
	const url = ctx.node.config.url as string | undefined;
	const caption = ctx.node.config.caption as string | undefined;
	const mediaType = (ctx.node.config.media_type as string | undefined) ?? "image";
	if (!url) return { kind: "fail", error: "telegram_send_media missing 'url'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const method =
		mediaType === "video"
			? "sendVideo"
			: mediaType === "audio"
				? "sendAudio"
				: mediaType === "document"
					? "sendDocument"
					: "sendPhoto";
	const field =
		method === "sendVideo"
			? "video"
			: method === "sendAudio"
				? "audio"
				: method === "sendDocument"
					? "document"
					: "photo";
	return tgCall(setup.botToken, method, {
		chat_id: setup.chatId,
		[field]: url,
		caption: render(caption, setup),
	});
};

export const telegramSendMediaGroupHandler: NodeHandler = async (ctx) => {
	const media = ctx.node.config.media as
		| Array<{ type: string; url: string; caption?: string }>
		| undefined;
	if (!media || media.length < 2)
		return {
			kind: "fail",
			error: "telegram_send_media_group requires 2+ items in 'media'",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "sendMediaGroup", {
		chat_id: setup.chatId,
		media: media.map((m) => ({
			type: m.type,
			media: m.url,
			caption: render(m.caption, setup),
		})),
	});
};

export const telegramSendPollHandler: NodeHandler = async (ctx) => {
	const question = ctx.node.config.question as string | undefined;
	const options = ctx.node.config.options as string[] | undefined;
	if (!question || !options || options.length < 2)
		return { kind: "fail", error: "telegram_send_poll missing question + 2+ options" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "sendPoll", {
		chat_id: setup.chatId,
		question,
		options,
		is_anonymous: ctx.node.config.is_anonymous ?? true,
		allows_multiple_answers: ctx.node.config.allows_multiple_answers ?? false,
	});
};

export const telegramSendLocationHandler: NodeHandler = async (ctx) => {
	const lat = ctx.node.config.latitude as number | undefined;
	const lon = ctx.node.config.longitude as number | undefined;
	if (lat === undefined || lon === undefined)
		return { kind: "fail", error: "telegram_send_location missing latitude/longitude" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "sendLocation", {
		chat_id: setup.chatId,
		latitude: lat,
		longitude: lon,
	});
};

export const telegramSendKeyboardHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const buttons = ctx.node.config.buttons as
		| Array<Array<{ text: string; callback_data?: string; url?: string }>>
		| undefined;
	if (!text) return { kind: "fail", error: "telegram_send_keyboard missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const inline_keyboard = (buttons ?? []).map((row) =>
		row.map((b) => ({
			text: b.text,
			...(b.url ? { url: b.url } : {}),
			...(b.callback_data ? { callback_data: b.callback_data } : {}),
		})),
	);
	return tgCall(setup.botToken, "sendMessage", {
		chat_id: setup.chatId,
		text: render(text, setup),
		reply_markup: { inline_keyboard },
	});
};

export const telegramEditMessageHandler: NodeHandler = async (ctx) => {
	const messageId =
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.last_message_id as string | undefined);
	const text = ctx.node.config.text as string | undefined;
	if (!messageId || !text)
		return {
			kind: "fail",
			error: "telegram_edit_message needs message_id + text",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "editMessageText", {
		chat_id: setup.chatId,
		message_id: Number(messageId),
		text: render(text, setup),
	});
};

export const telegramPinMessageHandler: NodeHandler = async (ctx) => {
	const messageId =
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.last_message_id as string | undefined);
	if (!messageId)
		return { kind: "fail", error: "telegram_pin_message needs message_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "pinChatMessage", {
		chat_id: setup.chatId,
		message_id: Number(messageId),
		disable_notification: ctx.node.config.disable_notification ?? true,
	});
};

export const telegramReactHandler: NodeHandler = async (ctx) => {
	const messageId =
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.last_message_id as string | undefined);
	const emoji = ctx.node.config.emoji as string | undefined;
	if (!messageId || !emoji)
		return {
			kind: "fail",
			error: "telegram_react needs message_id + emoji",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "setMessageReaction", {
		chat_id: setup.chatId,
		message_id: Number(messageId),
		reaction: [{ type: "emoji", emoji }],
	});
};

export const telegramSetChatActionHandler: NodeHandler = async (ctx) => {
	const action = (ctx.node.config.action as string | undefined) ?? "typing";
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return tgCall(setup.botToken, "sendChatAction", {
		chat_id: setup.chatId,
		action,
	});
};
