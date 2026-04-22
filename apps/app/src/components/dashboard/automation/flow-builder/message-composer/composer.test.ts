// Composer pure-helper tests (Plan 2 — Unit B3, Phase N).
//
// React Testing Library is not installed in apps/app, so we only cover the
// pure helpers here (block factories, interactive-element detection,
// channel-capability lookups, merge-tag resolution). When RTL lands, add a
// render test that covers add/remove/reorder + onChange callbacks.

import { describe, expect, it } from "bun:test";
import {
	capabilitiesFor,
	channelSupportsBlock,
	channelSupportsButtons,
	channelSupportsQuickReplies,
} from "../channel-capabilities";
import {
	generateBlockId,
	hasInteractiveElements,
	newBlock,
	newButton,
	newQuickReply,
	reorder,
	type MessageConfig,
} from "./types";
import {
	PREVIEW_MERGE_CONTEXT,
	resolveMergeTags,
} from "./merge-tags";

// ---------------------------------------------------------------------------
// newBlock
// ---------------------------------------------------------------------------

describe("newBlock", () => {
	it("returns a text block with empty string text", () => {
		const block = newBlock("text");
		expect(block.type).toBe("text");
		if (block.type === "text") {
			expect(block.text).toBe("");
			expect(block.buttons).toBeUndefined();
		}
		expect(typeof block.id).toBe("string");
		expect(block.id.length).toBeGreaterThan(0);
	});

	it("returns a media block with empty media_ref", () => {
		for (const kind of ["image", "video", "audio", "file"] as const) {
			const block = newBlock(kind);
			expect(block.type).toBe(kind);
			if (
				block.type === "image" ||
				block.type === "video" ||
				block.type === "audio" ||
				block.type === "file"
			) {
				expect(block.media_ref).toBe("");
			}
		}
	});

	it("returns a card block with empty title", () => {
		const block = newBlock("card");
		expect(block.type).toBe("card");
		if (block.type === "card") {
			expect(block.title).toBe("");
			expect(block.subtitle).toBeUndefined();
			expect(block.buttons).toBeUndefined();
		}
	});

	it("returns a gallery block with one blank card by default", () => {
		const block = newBlock("gallery");
		expect(block.type).toBe("gallery");
		if (block.type === "gallery") {
			expect(block.cards).toHaveLength(1);
			expect(block.cards[0]?.type).toBe("card");
			expect(block.cards[0]?.title).toBe("");
		}
	});

	it("returns a delay block with 1s default", () => {
		const block = newBlock("delay");
		expect(block.type).toBe("delay");
		if (block.type === "delay") {
			expect(block.seconds).toBe(1);
		}
	});

	it("generates unique ids", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) ids.add(generateBlockId());
		expect(ids.size).toBeGreaterThan(40); // overwhelmingly likely unique
	});
});

// ---------------------------------------------------------------------------
// hasInteractiveElements
// ---------------------------------------------------------------------------

describe("hasInteractiveElements", () => {
	it("returns false for empty config", () => {
		expect(hasInteractiveElements({})).toBe(false);
	});

	it("returns true when quick_replies is non-empty", () => {
		const cfg: MessageConfig = {
			quick_replies: [newQuickReply()],
		};
		expect(hasInteractiveElements(cfg)).toBe(true);
	});

	it("returns true when a text block has a branch button", () => {
		const cfg: MessageConfig = {
			blocks: [
				{
					id: "b",
					type: "text",
					text: "hi",
					buttons: [newButton("branch")],
				},
			],
		};
		expect(hasInteractiveElements(cfg)).toBe(true);
	});

	it("returns false when text block buttons are all url type", () => {
		const cfg: MessageConfig = {
			blocks: [
				{
					id: "b",
					type: "text",
					text: "hi",
					buttons: [{ ...newButton("url"), url: "https://x" }],
				},
			],
		};
		expect(hasInteractiveElements(cfg)).toBe(false);
	});

	it("returns true for a gallery card with a branch button", () => {
		const gallery = newBlock("gallery");
		if (gallery.type !== "gallery") throw new Error("bad factory");
		gallery.cards[0]!.buttons = [newButton("branch")];
		const cfg: MessageConfig = { blocks: [gallery] };
		expect(hasInteractiveElements(cfg)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// reorder
// ---------------------------------------------------------------------------

describe("reorder", () => {
	it("moves an item from index to index", () => {
		expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(reorder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
	});

	it("is a no-op when from === to", () => {
		const list = ["a", "b"];
		expect(reorder(list, 0, 0)).toBe(list);
	});

	it("clamps out-of-range destination", () => {
		expect(reorder(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
	});

	it("returns same reference when from is out of range", () => {
		const list = ["a", "b"];
		expect(reorder(list, 5, 0)).toBe(list);
	});
});

// ---------------------------------------------------------------------------
// Channel capabilities
// ---------------------------------------------------------------------------

describe("channel capabilities", () => {
	it("instagram supports text, image, video, card, gallery, buttons, quick replies", () => {
		expect(channelSupportsBlock("instagram", "text")).toBe(true);
		expect(channelSupportsBlock("instagram", "image")).toBe(true);
		expect(channelSupportsBlock("instagram", "video")).toBe(true);
		expect(channelSupportsBlock("instagram", "card")).toBe(true);
		expect(channelSupportsBlock("instagram", "gallery")).toBe(true);
		expect(channelSupportsButtons("instagram")).toBe(true);
		expect(channelSupportsQuickReplies("instagram")).toBe(true);
	});

	it("instagram does not support audio / file", () => {
		expect(channelSupportsBlock("instagram", "audio")).toBe(false);
		expect(channelSupportsBlock("instagram", "file")).toBe(false);
	});

	it("whatsapp does not support quick replies, card, gallery", () => {
		expect(channelSupportsQuickReplies("whatsapp")).toBe(false);
		expect(channelSupportsBlock("whatsapp", "card")).toBe(false);
		expect(channelSupportsBlock("whatsapp", "gallery")).toBe(false);
	});

	it("tiktok is no longer advertised as an automation channel", () => {
		// TikTok was removed from the automation channel list in Plan 6
		// Unit RR11 / Task 3 (no webhook, no normalizer, no real DM send).
		// Unknown channels fall back to DEFAULT_CAPS which is permissive;
		// the UI guards against picking tiktok via the channel-option enum.
		expect(channelSupportsBlock("tiktok", "audio")).toBe(true);
	});

	it("capabilitiesFor prefers live catalog over fallback", () => {
		const live = {
			instagram: {
				buttons: false,
				quick_replies: false,
				card: false,
				gallery: false,
				image: false,
				video: false,
				audio: false,
				file: false,
				delay: false,
			},
		};
		const caps = capabilitiesFor("instagram", live);
		expect(caps.buttons).toBe(false);
		expect(caps.image).toBe(false);
	});

	it("capabilitiesFor falls back when channel is unknown", () => {
		const caps = capabilitiesFor("never_heard_of_it");
		expect(caps.buttons).toBe(true); // DEFAULT_CAPS
	});
});

// ---------------------------------------------------------------------------
// resolveMergeTags
// ---------------------------------------------------------------------------

describe("resolveMergeTags", () => {
	it("resolves contact.* tags", () => {
		expect(
			resolveMergeTags("Hi {{contact.first_name}}!", PREVIEW_MERGE_CONTEXT),
		).toBe("Hi John!");
	});

	it("resolves the bare-name shorthand as contact.<name>", () => {
		expect(resolveMergeTags("{{first_name}}", PREVIEW_MERGE_CONTEXT)).toBe(
			"John",
		);
	});

	it("resolves run.* tags", () => {
		expect(resolveMergeTags("{{run.id}}", PREVIEW_MERGE_CONTEXT)).toBe(
			"run_preview",
		);
	});

	it("resolves account.* tags", () => {
		expect(resolveMergeTags("{{account.name}}", PREVIEW_MERGE_CONTEXT)).toBe(
			"Your Account",
		);
	});

	it("returns empty string for missing paths", () => {
		expect(
			resolveMergeTags("{{contact.unknown_field}}", PREVIEW_MERGE_CONTEXT),
		).toBe("");
	});

	it("returns empty for an empty template", () => {
		expect(resolveMergeTags("", PREVIEW_MERGE_CONTEXT)).toBe("");
	});

	it("leaves non-matching text unchanged", () => {
		expect(resolveMergeTags("no tags here", PREVIEW_MERGE_CONTEXT)).toBe(
			"no tags here",
		);
	});

	it("handles multiple tags in one string", () => {
		expect(
			resolveMergeTags(
				"Hi {{contact.first_name}}! Run {{run.id}}.",
				PREVIEW_MERGE_CONTEXT,
			),
		).toBe("Hi John! Run run_preview.");
	});
});
