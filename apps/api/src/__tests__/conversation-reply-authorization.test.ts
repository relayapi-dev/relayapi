import { describe, expect, it } from "bun:test";
import {
	isWithinConversationReplyWindow,
	MAX_CONVERSATION_REPLY_WINDOW_MS,
} from "../services/conversation-reply-authorization";

describe("conversation reply authorization window", () => {
	const now = new Date("2026-07-15T12:00:00.000Z");

	it("allows a reply at the exact 24-hour boundary", () => {
		expect(
			isWithinConversationReplyWindow(
				new Date(now.getTime() - MAX_CONVERSATION_REPLY_WINDOW_MS),
				now,
			),
		).toBe(true);
	});

	it("rejects a reply after 24 hours", () => {
		expect(
			isWithinConversationReplyWindow(
				new Date(now.getTime() - MAX_CONVERSATION_REPLY_WINDOW_MS - 1),
				now,
			),
		).toBe(false);
	});

	it("honors a shorter provider cap", () => {
		expect(
			isWithinConversationReplyWindow(
				new Date(now.getTime() - 61 * 60 * 1000),
				now,
				60 * 60 * 1000,
			),
		).toBe(false);
	});

	it("never lets a provider extend the application cap", () => {
		expect(
			isWithinConversationReplyWindow(
				new Date(now.getTime() - MAX_CONVERSATION_REPLY_WINDOW_MS - 1),
				now,
				7 * 24 * 60 * 60 * 1000,
			),
		).toBe(false);
	});

	it("rejects future inbound timestamps", () => {
		expect(
			isWithinConversationReplyWindow(
				new Date(now.getTime() + 1),
				now,
			),
		).toBe(false);
	});
});
