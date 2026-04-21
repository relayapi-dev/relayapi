// Message composer types (Plan 2 — Unit B3, Phase N).
//
// Client-side mirror of the backend `MessageBlockSchema` in
// `apps/api/src/schemas/automation-graph.ts`. Kept as plain TS types (not
// Zod) so the composer can render over in-progress, partially-filled blocks
// without parse errors.
//
// A `message` node stores its config under `AutomationNode.config`:
//   config: {
//     blocks: MessageBlock[],
//     quick_replies: QuickReply[],
//     wait_for_reply?: boolean,
//     no_response_timeout_min?: number,
//     typing_indicator_seconds?: number,
//   }

export type BlockButtonType = "branch" | "url" | "call" | "share";

export interface BlockButton {
	id: string;
	type: BlockButtonType;
	label: string;
	url?: string;
	phone?: string;
}

export interface TextBlock {
	id: string;
	type: "text";
	text: string;
	buttons?: BlockButton[];
}

export interface ImageBlock {
	id: string;
	type: "image";
	media_ref: string;
	caption?: string;
}

export interface VideoBlock {
	id: string;
	type: "video";
	media_ref: string;
	caption?: string;
}

export interface AudioBlock {
	id: string;
	type: "audio";
	media_ref: string;
}

export interface FileBlock {
	id: string;
	type: "file";
	media_ref: string;
}

export interface CardBlock {
	id: string;
	type: "card";
	media_ref?: string;
	title: string;
	subtitle?: string;
	buttons?: BlockButton[];
}

export interface GalleryBlock {
	id: string;
	type: "gallery";
	cards: CardBlock[];
}

export interface DelayBlock {
	id: string;
	type: "delay";
	seconds: number;
}

export type MessageBlock =
	| TextBlock
	| ImageBlock
	| VideoBlock
	| AudioBlock
	| FileBlock
	| CardBlock
	| GalleryBlock
	| DelayBlock;

export type MessageBlockType = MessageBlock["type"];

export interface QuickReply {
	id: string;
	label: string;
	icon?: string;
}

export interface MessageConfig {
	blocks?: MessageBlock[];
	quick_replies?: QuickReply[];
	wait_for_reply?: boolean;
	no_response_timeout_min?: number;
	typing_indicator_seconds?: number;
}

// ---------------------------------------------------------------------------
// Factories + pure helpers — used by the composer and unit-tested.
// ---------------------------------------------------------------------------

const ID_ALPHABET =
	"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** 8-char opaque id, matches the node-key generator style. */
export function generateBlockId(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.getRandomValues === "function"
	) {
		const buf = new Uint8Array(8);
		globalThis.crypto.getRandomValues(buf);
		let out = "";
		for (let i = 0; i < buf.length; i++) {
			out += ID_ALPHABET[buf[i]! % ID_ALPHABET.length];
		}
		return out;
	}
	return Math.random().toString(36).slice(2, 10);
}

/** Construct an empty block of the requested type. */
export function newBlock(type: MessageBlockType): MessageBlock {
	const id = generateBlockId();
	switch (type) {
		case "text":
			return { id, type: "text", text: "" };
		case "image":
			return { id, type: "image", media_ref: "" };
		case "video":
			return { id, type: "video", media_ref: "" };
		case "audio":
			return { id, type: "audio", media_ref: "" };
		case "file":
			return { id, type: "file", media_ref: "" };
		case "card":
			return { id, type: "card", title: "" };
		case "gallery":
			return {
				id,
				type: "gallery",
				cards: [{ id: generateBlockId(), type: "card", title: "" }],
			};
		case "delay":
			return { id, type: "delay", seconds: 1 };
	}
}

export function newButton(type: BlockButtonType = "branch"): BlockButton {
	return { id: generateBlockId(), type, label: "" };
}

export function newQuickReply(): QuickReply {
	return { id: generateBlockId(), label: "" };
}

/** True when the config has any port-producing interactive element. */
export function hasInteractiveElements(config: MessageConfig): boolean {
	const qrs = config.quick_replies ?? [];
	if (qrs.length > 0) return true;
	for (const block of config.blocks ?? []) {
		if (block.type === "text" || block.type === "card") {
			if (block.buttons?.some((b) => b.type === "branch")) return true;
		}
		if (block.type === "gallery") {
			for (const card of block.cards) {
				if (card.buttons?.some((b) => b.type === "branch")) return true;
			}
		}
	}
	return false;
}

/** Move an element of an array from one index to another (returns a copy). */
export function reorder<T>(list: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || from >= list.length) return list;
	const bounded = Math.max(0, Math.min(list.length - 1, to));
	const copy = list.slice();
	const [item] = copy.splice(from, 1);
	if (!item) return list;
	copy.splice(bounded, 0, item);
	return copy;
}
