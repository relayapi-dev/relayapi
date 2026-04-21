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
 * NOTE: `message-sender.ts` currently exposes a minimal `{ platform,
 * accessToken, platformAccountId, recipientId, text }` shape. Richer
 * payloads (buttons, attachments, cards, galleries, quick replies) are not
 * yet first-class in that interface. We encode them into the text for now
 * and surface structured metadata via `quick_replies` / `buttons` fields
 * on the request so a future enrichment of `SendMessageRequest` can pick
 * them up without touching this adapter. TODO(unit-5): extend
 * `SendMessageRequest` to carry native button / attachment payloads.
 */
function renderBlockToRequest(
	block: MessageBlock,
	input: AutomationSendInput,
	quickReplies: QuickReply[] | undefined,
): (SendMessageRequest & { quick_replies?: QuickReply[]; buttons?: unknown }) | null {
	const base = {
		platform: input.channel,
		accessToken: input.credentials.accessToken,
		platformAccountId: input.credentials.platformAccountId,
		recipientId: input.recipient.platformContactId,
	};

	switch (block.type) {
		case "text": {
			const buttons = (block.buttons ?? []).filter(
				(b) => b.type === "branch" || b.type === "url" || b.type === "call",
			);
			return {
				...base,
				text: block.text,
				...(buttons.length > 0 && CHANNEL_SUPPORTS_BUTTONS[input.channel]
					? { buttons }
					: {}),
				...(quickReplies && quickReplies.length > 0
					? { quick_replies: quickReplies }
					: {}),
			};
		}

		case "image":
		case "video":
		case "audio":
		case "file": {
			// TODO(unit-5): resolve `media_ref` through the media service.
			// For now we treat `media_ref` as a direct URL and surface it in
			// the `text` field so `message-sender.ts` still has something to
			// send. A future enrichment should move this to a native
			// attachment payload on SendMessageRequest.
			const url = block.media_ref;
			const caption =
				"caption" in block && block.caption ? block.caption : "";
			return {
				...base,
				text: caption ? `${caption}\n${url}` : url,
				...(quickReplies && quickReplies.length > 0
					? { quick_replies: quickReplies }
					: {}),
			};
		}

		case "card": {
			const lines = [
				block.title,
				block.subtitle ?? "",
				block.media_ref ?? "",
				...(block.buttons ?? []).map((b) => `[${b.label}]`),
			]
				.filter((s) => s.length > 0)
				.join("\n");
			return {
				...base,
				text: lines,
				...(block.buttons && CHANNEL_SUPPORTS_BUTTONS[input.channel]
					? { buttons: block.buttons }
					: {}),
				...(quickReplies && quickReplies.length > 0
					? { quick_replies: quickReplies }
					: {}),
			};
		}

		case "gallery": {
			const cardLines = block.cards.map((c) => {
				const parts = [c.title];
				if (c.subtitle) parts.push(c.subtitle);
				if (c.media_ref) parts.push(c.media_ref);
				return parts.join(" — ");
			});
			return {
				...base,
				text: cardLines.join("\n\n"),
				...(quickReplies && quickReplies.length > 0
					? { quick_replies: quickReplies }
					: {}),
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
