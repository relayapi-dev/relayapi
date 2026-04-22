// apps/api/src/__tests__/automation-platform-encoding.test.ts
//
// Per-platform payload encoding tests for `message-sender.ts`. Each test
// stubs `globalThis.fetch` via bun's `mock()`, calls `sendMessage()` with a
// structured `SendMessageRequest` (buttons, quick_replies, card, gallery,
// attachments), and asserts the outbound HTTP body matches the platform's
// native API shape.
//
// No real platform APIs are hit — all transport is mocked.

import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	sendMessage,
	type SendMessageRequest,
} from "../services/message-sender";

const originalFetch = globalThis.fetch;

type CapturedCall = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
};

function mockFetchCapture(): { calls: CapturedCall[] } {
	const calls: CapturedCall[] = [];
	globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		const headers: Record<string, string> = {};
		if (init?.headers) {
			const h = init.headers as Record<string, string>;
			for (const k of Object.keys(h)) headers[k] = h[k]!;
		}
		let parsedBody: unknown = null;
		if (init?.body) {
			if (typeof init.body === "string") {
				try {
					parsedBody = JSON.parse(init.body);
				} catch {
					parsedBody = init.body;
				}
			} else {
				parsedBody = init.body;
			}
		}
		calls.push({ url, method, headers, body: parsedBody });
		// Return a generic success response; shape mostly irrelevant for encoding tests.
		return new Response(
			JSON.stringify({
				message_id: "mid_ok",
				messages: [{ id: "wamid_ok" }],
				result: { message_id: 1234 },
				data: { dm_event_id: "dm_ok" },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	return { calls };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const base: Pick<
	SendMessageRequest,
	"accessToken" | "platformAccountId" | "recipientId"
> = {
	accessToken: "tok_abc",
	platformAccountId: "acct_123",
	recipientId: "recip_456",
};

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

describe("Instagram DM encoding", () => {
	it("encodes text + branch buttons as a button template", async () => {
		const { calls } = mockFetchCapture();
		const res = await sendMessage({
			platform: "instagram",
			...base,
			text: "Pick one:",
			buttons: [
				{ id: "a", type: "branch", label: "Option A" },
				{ id: "b", type: "branch", label: "Option B" },
			],
		});
		expect(res.success).toBe(true);
		expect(calls).toHaveLength(1);
		const body = calls[0]!.body as any;
		expect(body.recipient.id).toBe("recip_456");
		expect(body.message.attachment.type).toBe("template");
		expect(body.message.attachment.payload.template_type).toBe("button");
		expect(body.message.attachment.payload.text).toBe("Pick one:");
		expect(body.message.attachment.payload.buttons).toHaveLength(2);
		expect(body.message.attachment.payload.buttons[0]).toEqual({
			type: "postback",
			title: "Option A",
			payload: "a",
		});
	});

	it("attaches top-level quick_replies on the message body", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "instagram",
			...base,
			text: "How are you?",
			quick_replies: [
				{ id: "q1", label: "Good" },
				{ id: "q2", label: "Bad" },
			],
		});
		const body = calls[0]!.body as any;
		expect(body.message.text).toBe("How are you?");
		expect(body.message.quick_replies).toHaveLength(2);
		expect(body.message.quick_replies[0]).toEqual({
			content_type: "text",
			title: "Good",
			payload: "q1",
		});
	});

	it("encodes a gallery of 3 cards as a generic template with 3 elements", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "instagram",
			...base,
			text: "",
			gallery: [
				{ title: "Card 1", subtitle: "Sub 1", image_url: "https://ex.com/1.png" },
				{ title: "Card 2" },
				{
					title: "Card 3",
					buttons: [{ id: "buy3", type: "branch", label: "Buy" }],
				},
			],
		});
		const body = calls[0]!.body as any;
		expect(body.message.attachment.payload.template_type).toBe("generic");
		expect(body.message.attachment.payload.elements).toHaveLength(3);
		expect(body.message.attachment.payload.elements[0].title).toBe("Card 1");
		expect(body.message.attachment.payload.elements[0].image_url).toBe(
			"https://ex.com/1.png",
		);
		expect(body.message.attachment.payload.elements[2].buttons[0]).toEqual({
			type: "postback",
			title: "Buy",
			payload: "buy3",
		});
	});

	it("skips call/share buttons on Instagram (not supported)", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "instagram",
			...base,
			text: "Contact us",
			buttons: [
				{ id: "c", type: "call", label: "Call", phone: "+1555" },
				{ id: "s", type: "share", label: "Share" },
				{ id: "u", type: "url", label: "Visit", url: "https://ex.com" },
			],
		});
		const body = calls[0]!.body as any;
		const btns = body.message.attachment.payload.buttons;
		expect(btns).toHaveLength(1);
		expect(btns[0].type).toBe("web_url");
	});

	it("sends a plain attachment when no buttons/card/gallery present", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "instagram",
			...base,
			text: "",
			attachments: [{ type: "image", url: "https://ex.com/photo.jpg" }],
		});
		const body = calls[0]!.body as any;
		expect(body.message.attachment.type).toBe("image");
		expect(body.message.attachment.payload.url).toBe("https://ex.com/photo.jpg");
	});
});

// ---------------------------------------------------------------------------
// Facebook Messenger
// ---------------------------------------------------------------------------

describe("Facebook Messenger encoding", () => {
	it("encodes text + branch buttons as a button template (same shape as IG)", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "facebook",
			...base,
			text: "Choose:",
			buttons: [{ id: "yes", type: "branch", label: "Yes" }],
		});
		const body = calls[0]!.body as any;
		expect(body.messaging_type).toBe("UPDATE");
		expect(body.message.attachment.payload.template_type).toBe("button");
		expect(body.message.attachment.payload.text).toBe("Choose:");
		expect(body.message.attachment.payload.buttons[0].type).toBe("postback");
	});

	it("encodes phone_number buttons on Messenger (unlike IG)", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "facebook",
			...base,
			text: "Call us",
			buttons: [{ id: "c", type: "call", label: "Call", phone: "+15551234" }],
		});
		const body = calls[0]!.body as any;
		const btn = body.message.attachment.payload.buttons[0];
		expect(btn.type).toBe("phone_number");
		expect(btn.payload).toBe("+15551234");
	});
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

describe("WhatsApp encoding", () => {
	it("encodes text + branch buttons as an interactive button payload", async () => {
		const { calls } = mockFetchCapture();
		const res = await sendMessage({
			platform: "whatsapp",
			...base,
			text: "Confirm your order:",
			buttons: [
				{ id: "yes", type: "branch", label: "Yes" },
				{ id: "no", type: "branch", label: "No" },
			],
		});
		expect(res.success).toBe(true);
		const body = calls[0]!.body as any;
		expect(body.messaging_product).toBe("whatsapp");
		expect(body.type).toBe("interactive");
		expect(body.interactive.type).toBe("button");
		expect(body.interactive.body.text).toBe("Confirm your order:");
		expect(body.interactive.action.buttons).toHaveLength(2);
		expect(body.interactive.action.buttons[0]).toEqual({
			type: "reply",
			reply: { id: "yes", title: "Yes" },
		});
	});

	it("skips quick_replies / card / gallery silently (not a protocol error)", async () => {
		const { calls } = mockFetchCapture();
		const res = await sendMessage({
			platform: "whatsapp",
			...base,
			text: "hello",
			quick_replies: [{ id: "q", label: "Q" }],
			gallery: [{ title: "X" }],
		});
		expect(res.success).toBe(true);
		const body = calls[0]!.body as any;
		// Text with no buttons → plain text payload. No `interactive` or
		// `template` keys produced for quick_replies / card / gallery.
		expect(body.type).toBe("text");
		expect(body.text.body).toBe("hello");
	});

	it("sends an attachment as image/video/audio/document", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "whatsapp",
			...base,
			text: "",
			attachments: [
				{ type: "image", url: "https://ex.com/pic.jpg", caption: "nice" },
			],
		});
		const body = calls[0]!.body as any;
		expect(body.type).toBe("image");
		expect(body.image.link).toBe("https://ex.com/pic.jpg");
		expect(body.image.caption).toBe("nice");
	});
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe("Telegram encoding", () => {
	it("encodes branch buttons as inline_keyboard with callback_data", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "telegram",
			...base,
			text: "Pick one:",
			buttons: [
				{ id: "a", type: "branch", label: "A" },
				{ id: "b", type: "branch", label: "B" },
			],
		});
		expect(calls[0]!.url).toContain("/sendMessage");
		const body = calls[0]!.body as any;
		expect(body.text).toBe("Pick one:");
		expect(body.reply_markup.inline_keyboard).toEqual([
			[{ text: "A", callback_data: "a" }],
			[{ text: "B", callback_data: "b" }],
		]);
	});

	it("encodes url buttons as inline_keyboard url buttons", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "telegram",
			...base,
			text: "Visit:",
			buttons: [{ id: "u", type: "url", label: "Site", url: "https://ex.com" }],
		});
		const body = calls[0]!.body as any;
		expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
			text: "Site",
			url: "https://ex.com",
		});
	});

	it("encodes quick_replies as reply keyboard with one_time_keyboard", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "telegram",
			...base,
			text: "How are you?",
			quick_replies: [
				{ id: "g", label: "Good" },
				{ id: "b", label: "Bad", icon: "😢" },
			],
		});
		const body = calls[0]!.body as any;
		expect(body.reply_markup.one_time_keyboard).toBe(true);
		expect(body.reply_markup.keyboard).toEqual([
			[{ text: "Good" }],
			[{ text: "😢 Bad" }],
		]);
	});

	it("routes attachments to sendPhoto / sendVideo / sendDocument / sendAudio", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "telegram",
			...base,
			text: "",
			attachments: [{ type: "video", url: "https://ex.com/v.mp4" }],
		});
		expect(calls[0]!.url).toContain("/sendVideo");
		const body = calls[0]!.body as any;
		expect(body.video).toBe("https://ex.com/v.mp4");
	});

	it("degrades a card with image_url to a sendPhoto with caption", async () => {
		const { calls } = mockFetchCapture();
		await sendMessage({
			platform: "telegram",
			...base,
			text: "",
			card: {
				title: "Product X",
				subtitle: "Best product",
				image_url: "https://ex.com/px.png",
			},
		});
		expect(calls[0]!.url).toContain("/sendPhoto");
		const body = calls[0]!.body as any;
		expect(body.photo).toBe("https://ex.com/px.png");
		expect(body.caption).toContain("Product X");
		expect(body.caption).toContain("Best product");
	});
});

// ---------------------------------------------------------------------------
// TikTok — interactive fields silently dropped
// ---------------------------------------------------------------------------

describe("TikTok DM encoding", () => {
	it("returns success without hitting fetch even when buttons are supplied", async () => {
		const { calls } = mockFetchCapture();
		const res = await sendMessage({
			platform: "tiktok",
			...base,
			text: "Hi",
			buttons: [{ id: "a", type: "branch", label: "A" }],
		});
		expect(res.success).toBe(true);
		// Stub implementation is a no-op; it must NOT have issued an HTTP call.
		expect(calls).toHaveLength(0);
	});
});
