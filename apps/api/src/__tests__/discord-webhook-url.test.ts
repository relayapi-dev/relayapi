import { describe, expect, test } from "bun:test";
import { parseDiscordWebhookUrl } from "../lib/discord-webhook";

describe("parseDiscordWebhookUrl", () => {
	test("accepts canonical and versioned Discord webhook URLs", () => {
		expect(
			parseDiscordWebhookUrl(
				"https://discord.com/api/webhooks/123456789/Abc_def-123.token",
			),
		).toEqual({
			url: "https://discord.com/api/webhooks/123456789/Abc_def-123.token",
			webhookId: "123456789",
			webhookToken: "Abc_def-123.token",
		});
		expect(
			parseDiscordWebhookUrl(
				"https://discord.com/api/v10/webhooks/123456789/Abc_def-123",
			).webhookId,
		).toBe("123456789");
	});

	test.each([
		"https://example.com/discord.com/api/webhooks/123/token",
		"https://discord.com.evil.test/api/webhooks/123/token",
		"http://discord.com/api/webhooks/123/token",
		"https://discord.com:8443/api/webhooks/123/token",
		"https://discord.com/api/webhooks/123/token?redirect=evil",
		"https://discord.com/api/webhooks/not-a-snowflake/token",
	])("rejects unsafe URL %s", (value) => {
		expect(() => parseDiscordWebhookUrl(value)).toThrow();
	});
});
