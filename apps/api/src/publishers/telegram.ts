import {
	classifyPublishError,
	type MediaAttachment,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const TELEGRAM_API = "https://api.telegram.org";

interface TelegramResponse {
	ok: boolean;
	description?: string;
	result?: TelegramMessage | TelegramMessage[];
}

interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string; title?: string; username?: string };
}

function buildBaseUrl(token: string, method: string): string {
	return `${TELEGRAM_API}/bot${token}/${method}`;
}

/** Shared params applied to every Telegram API call. */
function applyCommonParams(
	params: Record<string, unknown>,
	chatId: string,
	opts: Record<string, unknown>,
): void {
	params.chat_id = chatId;
	if (opts.silent) {
		params.disable_notification = true;
	}
	if (opts.protect_content) {
		params.protect_content = true;
	}
}

async function callTelegramApi(
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<TelegramResponse> {
	const url = buildBaseUrl(token, method);
	// Telegram Bot API: Call the specified bot method (e.g. sendMessage, sendPhoto, etc.)
	// https://core.telegram.org/bots/api#available-methods
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json()) as TelegramResponse;
	if (!data.ok) {
		const desc = data.description ?? `Telegram API error: ${method}`;
		if (data.description?.includes("Too Many Requests")) {
			throw new Error(`RATE_LIMITED: ${desc}`);
		}
		if (data.description?.includes("Unauthorized") || data.description?.includes("bot was blocked")) {
			throw new Error(`TOKEN_EXPIRED: ${desc}`);
		}
		throw new Error(desc);
	}
	return data;
}

function buildMessageUrl(
	chatId: string,
	messageId: number,
	chat?: TelegramMessage["chat"],
): string | undefined {
	// Public channels/groups with a username get a t.me link
	if (chat?.username) {
		return `https://t.me/${chat.username}/${messageId}`;
	}
	// Private channels: strip the -100 prefix from numeric chat id
	if (chatId.startsWith("-100")) {
		const channelId = chatId.slice(4);
		return `https://t.me/c/${channelId}/${messageId}`;
	}
	return undefined;
}

function resolveMediaType(
	m: MediaAttachment,
): "photo" | "video" | "document" | "animation" | "audio" {
	switch (m.type) {
		case "image":
			return "photo";
		case "video":
			return "video";
		case "gif":
			return "animation";
		case "document":
			return "document";
		default:
			return "document";
	}
}

async function sendTextMessage(
	token: string,
	chatId: string,
	content: string,
	opts: Record<string, unknown>,
): Promise<PublishResult> {
	if (content.length > 4096) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Content is ${content.length} characters. Telegram text limit is 4,096.`,
			},
		};
	}

	const params: Record<string, unknown> = { text: content };
	applyCommonParams(params, chatId, opts);

	if (opts.parse_mode) {
		params.parse_mode = opts.parse_mode;
	}
	if (opts.disable_preview) {
		params.link_preview_options = { is_disabled: true };
	}

	// Telegram Bot API: Send a text message to a chat
	// https://core.telegram.org/bots/api#sendmessage
	const data = await callTelegramApi(token, "sendMessage", params);
	const msg = data.result as TelegramMessage;

	return {
		success: true,
		platform_post_id: String(msg.message_id),
		platform_url: buildMessageUrl(chatId, msg.message_id, msg.chat),
	};
}

async function sendSingleMedia(
	token: string,
	chatId: string,
	media: MediaAttachment,
	caption: string | null,
	opts: Record<string, unknown>,
): Promise<PublishResult> {
	if (caption && caption.length > 1024) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Caption is ${caption.length} characters. Telegram caption limit is 1,024.`,
			},
		};
	}

	const mediaType = resolveMediaType(media);

	let method: string;
	const params: Record<string, unknown> = {};

	switch (mediaType) {
		case "photo":
			method = "sendPhoto";
			params.photo = media.url;
			break;
		case "video":
			method = "sendVideo";
			params.video = media.url;
			break;
		case "animation":
			method = "sendAnimation";
			params.animation = media.url;
			break;
		case "audio":
			method = "sendAudio";
			params.audio = media.url;
			break;
		case "document":
			method = "sendDocument";
			params.document = media.url;
			break;
	}

	applyCommonParams(params, chatId, opts);

	if (caption) {
		params.caption = caption;
		if (opts.parse_mode) {
			params.parse_mode = opts.parse_mode;
		}
	}

	// Telegram Bot API: Send a single media item (photo, video, animation, or document)
	// https://core.telegram.org/bots/api#sendphoto / #sendvideo / #sendanimation / #senddocument
	const data = await callTelegramApi(token, method, params);
	const msg = data.result as TelegramMessage;

	return {
		success: true,
		platform_post_id: String(msg.message_id),
		platform_url: buildMessageUrl(chatId, msg.message_id, msg.chat),
	};
}

async function sendMediaGroup(
	token: string,
	chatId: string,
	mediaItems: MediaAttachment[],
	caption: string | null,
	opts: Record<string, unknown>,
): Promise<PublishResult> {
	// Telegram Bot API requires 2-10 items in a media group
	if (mediaItems.length < 2) {
		return sendSingleMedia(token, chatId, mediaItems[0]!, caption, opts);
	}

	if (caption && caption.length > 1024) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Caption is ${caption.length} characters. Telegram caption limit is 1,024.`,
			},
		};
	}

	// sendMediaGroup does not support animation/GIF — Telegram infers type from URL
	// and rejects animations even when labeled as "document"
	const hasAnimation = mediaItems.some((m) => resolveMediaType(m) === "animation");
	const filteredItems = hasAnimation
		? mediaItems.filter((m) => resolveMediaType(m) !== "animation")
		: mediaItems;

	// After filtering animations, check if we still have enough items for a group
	if (filteredItems.length < 2) {
		// Fall back to sending the first item as a single media message
		const firstItem = mediaItems[0];
		if (!firstItem) {
			throw new Error("No media items to send");
		}
		return sendSingleMedia(token, chatId, firstItem, caption, opts);
	}

	// Telegram requires consistent types: photos+videos can mix, documents only with documents, audio only with audio
	// Docs: https://core.telegram.org/bots/api#sendmediagroup
	const hasPhoto = filteredItems.some((m) => resolveMediaType(m) === "photo");
	const hasVideo = filteredItems.some((m) => resolveMediaType(m) === "video");
	const hasDocument = filteredItems.some((m) => resolveMediaType(m) === "document");
	const hasAudio = filteredItems.some((m) => resolveMediaType(m) === "audio");

	if (hasDocument && (hasPhoto || hasVideo || hasAudio)) {
		return {
			success: false,
			error: {
				code: "INVALID_MEDIA_MIX",
				message: "Telegram does not allow mixing documents with photos, videos, or audio in a media group.",
			},
		};
	}
	if (hasAudio && (hasPhoto || hasVideo || hasDocument)) {
		return {
			success: false,
			error: {
				code: "INVALID_MEDIA_MIX",
				message: "Telegram does not allow mixing audio with photos, videos, or documents in a media group.",
			},
		};
	}

	const inputMedia = filteredItems.slice(0, 10).map((m, i) => {
		const mediaType = resolveMediaType(m);
		const type = mediaType;

		const item: Record<string, unknown> = {
			type,
			media: m.url,
		};

		// Caption goes on the first item only
		if (i === 0 && caption) {
			item.caption = caption;
			if (opts.parse_mode) {
				item.parse_mode = opts.parse_mode;
			}
		}

		return item;
	});

	const params: Record<string, unknown> = { media: inputMedia };
	applyCommonParams(params, chatId, opts);

	// Telegram Bot API: Send a group of photos, videos, documents, or audios as an album
	// https://core.telegram.org/bots/api#sendmediagroup
	const data = await callTelegramApi(token, "sendMediaGroup", params);
	const messages = data.result as TelegramMessage[];
	const firstMsg = messages[0];

	return {
		success: true,
		platform_post_id: firstMsg ? String(firstMsg.message_id) : undefined,
		platform_url: firstMsg
			? buildMessageUrl(chatId, firstMsg.message_id, firstMsg.chat)
			: undefined,
	};
}

export const telegramPublisher: Publisher = {
	platform: "telegram",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const token = request.account.access_token;
			const chatId = request.account.platform_account_id;
			const opts = request.target_options;

			// Resolve content and media — target_options can override both
			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// No media → text message
			if (!media || media.length === 0) {
				if (!content) {
					return {
						success: false,
						error: {
							code: "EMPTY_CONTENT",
							message: "No content or media provided for Telegram post.",
						},
					};
				}
				return sendTextMessage(token, chatId, content, opts);
			}

			// Single media item
			if (media.length === 1) {
				return sendSingleMedia(
					token,
					chatId,
					media[0] as MediaAttachment,
					content || null,
					opts,
				);
			}

			// Multiple media → album
			return sendMediaGroup(
				token,
				chatId,
				media as MediaAttachment[],
				content || null,
				opts,
			);
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
