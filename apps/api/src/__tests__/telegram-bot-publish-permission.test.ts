import { describe, expect, test } from "bun:test";
import { canTelegramBotPublish } from "../services/telegram-connection";

describe("Telegram managed bot publish permission", () => {
	test("requires explicit channel post permission", () => {
		expect(
			canTelegramBotPublish("channel", {
				status: "administrator",
				can_post_messages: true,
			}),
		).toBe(true);
		expect(
			canTelegramBotPublish("channel", {
				status: "administrator",
				can_post_messages: false,
			}),
		).toBe(false);
		expect(canTelegramBotPublish("channel", { status: "member" })).toBe(false);
	});

	test("accepts publishable group membership and rejects removed bots", () => {
		expect(canTelegramBotPublish("supergroup", { status: "member" })).toBe(
			true,
		);
		expect(
			canTelegramBotPublish("group", {
				status: "restricted",
				can_send_messages: true,
			}),
		).toBe(true);
		expect(canTelegramBotPublish("group", { status: "left" })).toBe(false);
		expect(canTelegramBotPublish("group", { status: "kicked" })).toBe(false);
	});
});
