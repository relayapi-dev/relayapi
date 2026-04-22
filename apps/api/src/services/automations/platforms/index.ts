// apps/api/src/services/automations/platforms/index.ts
//
// Channel dispatcher for the automation runtime's `message` node. Turns the
// rendered block list into one or more outbound messages, delegating the
// actual HTTP call to the preserved `message-sender.ts` service.
//
// Design spec: docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
//   §5  (message blocks)
//   §8.3 (runner)
//   §11 (message composer)
//
// IMPORTANT: This module must not duplicate platform HTTP calls. All network
// traffic goes through `sendMessage(req)` from `../../message-sender`. The
// adapter's job is:
//   1. Iterate blocks in order
//   2. Enforce the channel capability matrix (skip unsupported block types)
//   3. Build a `SendMessageRequest` per block and call `sendMessage`
//   4. Return a per-block result list for the message handler to persist

import {
	sendMessage,
	type SendMessageRequest,
	type SendMessageResult,
} from "../../message-sender";
import type {
	MessageBlock,
	QuickReply,
} from "../../../schemas/automation-graph";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AutomationChannel =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram"
	| "tiktok";

export type AutomationSendInput = {
	channel: AutomationChannel;
	socialAccountId: string;
	recipient: {
		contactId: string;
		/** Platform-native contact id: IG IGSID, FB PSID, WA phone, TG chat_id, TikTok user_id */
		platformContactId: string;
		conversationId?: string | null;
	};
	blocks: MessageBlock[];
	quickReplies?: QuickReply[];
	/** If set, apply a typing indicator delay before the FIRST block. */
	typingDelayMs?: number;
	/**
	 * Platform credentials — resolved upstream. The message handler fetches
	 * and decrypts these before calling dispatch so the adapter stays pure.
	 */
	credentials: {
		accessToken: string;
		platformAccountId: string;
	};
	/**
	 * Optional transport override for tests. When present, used in place of
	 * the real `sendMessage(req)` call. This is the cleanest way to exercise
	 * the dispatcher without mocking the preserved message-sender module.
	 */
	sendTransport?: (req: SendMessageRequest) => Promise<SendMessageResult>;
};

export type AutomationSendResult = {
	sent: Array<{
		blockId: string;
		providerMessageId?: string;
		skipped?: boolean;
		reason?: string;
	}>;
	errors: Array<{ blockId: string; error: string }>;
};

// ---------------------------------------------------------------------------
// Channel capability matrix
// ---------------------------------------------------------------------------

type BlockType = MessageBlock["type"];

export const CHANNEL_CAPABILITIES: Record<
	AutomationChannel,
	Record<BlockType, boolean>
> = {
	instagram: {
		text: true,
		image: true,
		video: true,
		audio: false,
		file: false,
		card: true,
		gallery: true,
		delay: true,
	},
	facebook: {
		text: true,
		image: true,
		video: true,
		audio: true,
		file: true,
		card: true,
		gallery: true,
		delay: true,
	},
	whatsapp: {
		text: true,
		image: true,
		video: true,
		audio: true,
		file: true,
		card: false,
		gallery: false,
		delay: true,
	},
	telegram: {
		text: true,
		image: true,
		video: true,
		audio: true,
		file: true,
		card: false,
		gallery: false,
		delay: true,
	},
	tiktok: {
		text: true,
		image: true,
		video: true,
		audio: false,
		file: false,
		card: false,
		gallery: false,
		delay: true,
	},
};

export const CHANNEL_SUPPORTS_BUTTONS: Record<AutomationChannel, boolean> = {
	instagram: true,
	facebook: true,
	whatsapp: true,
	telegram: true,
	tiktok: false,
};

export const CHANNEL_SUPPORTS_QUICK_REPLIES: Record<
	AutomationChannel,
	boolean
> = {
	instagram: true,
	facebook: true,
	whatsapp: false,
	telegram: true,
	tiktok: false,
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a rendered message to the appropriate channel. Iterates blocks in
 * order, honors channel capability rules (unsupported block types are silently
 * skipped with `reason: "unsupported_by_channel"`), and returns a per-block
 * result. Errors on individual blocks do not short-circuit the rest of the
 * message — every block is attempted.
 */
export async function dispatchAutomationMessage(
	input: AutomationSendInput,
): Promise<AutomationSendResult> {
	const sent: AutomationSendResult["sent"] = [];
	const errors: AutomationSendResult["errors"] = [];

	const sendFn = input.sendTransport ?? sendMessage;
	const blocks = input.blocks ?? [];
	const capability = CHANNEL_CAPABILITIES[input.channel];
	if (!capability) {
		return {
			sent: [],
			errors: [
				{
					blockId: "<dispatcher>",
					error: `unsupported channel: ${input.channel}`,
				},
			],
		};
	}

	// Typing indicator / leading delay. We intentionally gate this behind a
	// non-zero value so the common "no typing indicator" path stays instant.
	if (input.typingDelayMs && input.typingDelayMs > 0) {
		await wait(input.typingDelayMs);
	}

	// Find the index of the LAST sendable (non-delay) block so we know where
	// to attach quick_replies per Messenger/Instagram/Telegram convention.
	const lastSendableIndex = findLastSendableIndex(blocks, capability);

	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i]!;

		// In-message delay is a pause, not an outbound message.
		if (block.type === "delay") {
			const ms = Math.max(0, Math.round((block.seconds ?? 0) * 1000));
			if (ms > 0) await wait(ms);
			sent.push({ blockId: block.id, skipped: true, reason: "delay_block" });
			continue;
		}

		if (!capability[block.type]) {
			sent.push({
				blockId: block.id,
				skipped: true,
				reason: "unsupported_by_channel",
			});
			continue;
		}

		const attachQuickReplies =
			i === lastSendableIndex &&
			(input.quickReplies?.length ?? 0) > 0 &&
			CHANNEL_SUPPORTS_QUICK_REPLIES[input.channel];

		const req = renderBlockToRequest(
			block,
			input,
			attachQuickReplies ? input.quickReplies : undefined,
		);
		if (!req) {
			sent.push({
				blockId: block.id,
				skipped: true,
				reason: "unrenderable",
			});
			continue;
		}

		try {
			const res = await sendFn(req);
			if (res.success) {
				sent.push({ blockId: block.id, providerMessageId: res.messageId });
			} else {
				errors.push({
					blockId: block.id,
					error: res.error ?? "send_failed",
				});
			}
		} catch (err) {
			errors.push({
				blockId: block.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { sent, errors };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/**
 * Convert a single MessageBlock into a SendMessageRequest understood by
 * `message-sender.ts`. Returns null if the block has nothing to send (e.g.
 * an image block with no media_ref resolved).
 *
 * Rich payloads (buttons, cards, galleries, attachments, quick replies) are
 * passed through as native fields on `SendMessageRequest`. Per-platform
 * encoding into API-specific shapes (IG button template, Telegram
 * inline_keyboard, WhatsApp interactive buttons, etc.) happens inside
 * `message-sender.ts`. The adapter only:
 *   1. Picks the right `SendMessageRequest` shape per block kind.
 *   2. Filters out platform-unsupported buttons (only `branch` / `url` on
 *      WhatsApp, no `call` / `share` on TikTok, etc.) via
 *      `CHANNEL_SUPPORTS_BUTTONS`.
 *   3. Attaches quick_replies to the LAST sendable block only.
 */
function renderBlockToRequest(
	block: MessageBlock,
	input: AutomationSendInput,
	quickReplies: QuickReply[] | undefined,
): SendMessageRequest | null {
	const base = {
		platform: input.channel,
		accessToken: input.credentials.accessToken,
		platformAccountId: input.credentials.platformAccountId,
		recipientId: input.recipient.platformContactId,
	};

	const qr =
		quickReplies &&
		quickReplies.length > 0 &&
		CHANNEL_SUPPORTS_QUICK_REPLIES[input.channel]
			? { quick_replies: quickReplies }
			: {};

	switch (block.type) {
		case "text": {
			const buttons =
				block.buttons && CHANNEL_SUPPORTS_BUTTONS[input.channel]
					? block.buttons
					: undefined;
			return {
				...base,
				text: block.text,
				...(buttons && buttons.length > 0 ? { buttons } : {}),
				...qr,
			};
		}

		case "image":
		case "video":
		case "audio":
		case "file": {
			const url = block.media_ref;
			if (!url) return null;
			const caption =
				"caption" in block && block.caption ? block.caption : undefined;
			return {
				...base,
				text: "",
				attachments: [
					{
						type: block.type,
						url,
						...(caption ? { caption } : {}),
					},
				],
				...qr,
			};
		}

		case "card": {
			return {
				...base,
				text: "",
				card: {
					title: block.title,
					...(block.subtitle ? { subtitle: block.subtitle } : {}),
					...(block.media_ref ? { image_url: block.media_ref } : {}),
					...(block.buttons && CHANNEL_SUPPORTS_BUTTONS[input.channel]
						? { buttons: block.buttons }
						: {}),
				},
				...qr,
			};
		}

		case "gallery": {
			return {
				...base,
				text: "",
				gallery: block.cards.map((c) => ({
					title: c.title,
					...(c.subtitle ? { subtitle: c.subtitle } : {}),
					...(c.media_ref ? { image_url: c.media_ref } : {}),
					...(c.buttons && CHANNEL_SUPPORTS_BUTTONS[input.channel]
						? { buttons: c.buttons }
						: {}),
				})),
				...qr,
			};
		}

		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLastSendableIndex(
	blocks: MessageBlock[],
	capability: Record<BlockType, boolean>,
): number {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const b = blocks[i]!;
		if (b.type === "delay") continue;
		if (!capability[b.type]) continue;
		return i;
	}
	return -1;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
