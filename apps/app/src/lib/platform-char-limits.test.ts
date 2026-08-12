import { describe, expect, test } from "bun:test";
import { SOCIAL_PLATFORM_IDS } from "@relayapi/db";
import {
	countCharsForPlatform,
	PLATFORM_CHAR_LIMITS,
	TOOL_PLATFORM_IDS,
	TOOL_PLATFORMS,
} from "./platform-char-limits";

describe("dashboard publishing-tool platform contract", () => {
	test("exposes the exact canonical 22-platform set", () => {
		expect(TOOL_PLATFORM_IDS).toEqual(SOCIAL_PLATFORM_IDS);
		expect(TOOL_PLATFORMS).toHaveLength(22);
		expect(new Set(TOOL_PLATFORMS.map(({ id }) => id)).size).toBe(22);
		expect(TOOL_PLATFORMS.every(({ label }) => label.length > 0)).toBe(true);
	});

	test("matches every API runtime character limit", () => {
		expect(
			Object.fromEntries(
				SOCIAL_PLATFORM_IDS.map((platform) => [
					platform,
					PLATFORM_CHAR_LIMITS[platform].maxChars,
				]),
			),
		).toEqual({
			twitter: 280,
			instagram: 2200,
			facebook: 63206,
			linkedin: 3000,
			tiktok: 2200,
			youtube: 5000,
			pinterest: 800,
			reddit: 40000,
			bluesky: 300,
			threads: 500,
			telegram: 4096,
			snapchat: 250,
			googlebusiness: 1500,
			whatsapp: 4096,
			mastodon: 500,
			discord: 2000,
			sms: 1600,
			beehiiv: 100_000,
			convertkit: 100_000,
			mailchimp: 100_000,
			listmonk: 100_000,
			slack: 40_000,
		});
		expect(PLATFORM_CHAR_LIMITS.pinterest.maxChars).toBe(800);
	});

	test("matches the API's weighted X character counting rules", () => {
		expect(countCharsForPlatform("hello", "twitter")).toBe(5);
		expect(countCharsForPlatform("😀", "twitter")).toBe(2);
		expect(
			countCharsForPlatform(
				"go https://example.com/a/very/long/path",
				"twitter",
			),
		).toBe(26);
	});
});
