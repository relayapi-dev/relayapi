import { afterEach, describe, expect, it, mock } from "bun:test";
import { buildMailchimpApiUrl, getMailchimpDatacenter } from "../lib/mailchimp";
import {
	mailchimpPublisher,
	normalizeMailchimpScheduleTime,
} from "../publishers/mailchimp";
import { ConnectMailchimpBody } from "../schemas/connect";
import {
	createTelegramChallengeCode,
	telegramChallengeId,
} from "../services/telegram-connection";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Mailchimp host validation", () => {
	it("rounds requested campaign delivery forward to the documented quarter-hour", () => {
		expect(normalizeMailchimpScheduleTime("2026-07-15T12:15:00.000Z")).toBe(
			"2026-07-15T12:15:00.000Z",
		);
		expect(normalizeMailchimpScheduleTime("2026-07-15T12:15:00.001Z")).toBe(
			"2026-07-15T12:30:00.000Z",
		);
		expect(() => normalizeMailchimpScheduleTime("not-a-date")).toThrow(
			"valid ISO 8601",
		);
	});

	it("accepts documented datacenter suffixes and constructs the exact origin", () => {
		expect(getMailchimpDatacenter("0123456789abcdef-us21")).toBe("us21");
		const url = buildMailchimpApiUrl("us21", "/3.0/lists?count=1");
		expect(url.origin).toBe("https://us21.api.mailchimp.com");
		expect(url.pathname).toBe("/3.0/lists");
	});

	it("rejects URL delimiters and attacker-controlled hosts in API-key suffixes", () => {
		const maliciousKeys = [
			"key-evil.example/path",
			"key-us21@evil.example",
			"key-us21?@evil.example",
			"key-us21#@evil.example",
			"key-US21",
			"key-us",
			"key-us21.example",
		];

		for (const apiKey of maliciousKeys) {
			expect(getMailchimpDatacenter(apiKey)).toBeNull();
			expect(ConnectMailchimpBody.safeParse({ api_key: apiKey }).success).toBe(
				false,
			);
		}
	});

	it("rejects path-based attempts to override the validated origin", () => {
		expect(() =>
			buildMailchimpApiUrl("us21", "https://evil.example/steal"),
		).toThrow("Invalid Mailchimp API URL");
		expect(() => buildMailchimpApiUrl("evil.example", "/3.0/")).toThrow(
			"Invalid Mailchimp datacenter",
		);
	});

	it("derives the publisher host from the API key and ignores persisted metadata", async () => {
		const requestedUrls: string[] = [];
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			requestedUrls.push(url.href);
			if (url.pathname === "/3.0/campaigns") {
				return Response.json({ id: "campaign_123" });
			}
			return new Response(null, { status: 200 });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await mailchimpPublisher.publish({
			operation_id: "test:mailchimp:poisoned-metadata",
			content: "Newsletter",
			media: [],
			target_options: {
				from_email: "sender@example.test",
				list_id: "list_123",
			},
			account: {
				id: "acc_123",
				platform: "mailchimp",
				access_token: `${"01234567".repeat(2)}-us21`,
				refresh_token: null,
				platform_account_id: "mc_123",
				username: "test",
				metadata: { datacenter: "evil.example/path" },
			},
		});

		expect(result.success).toBe(true);
		expect(requestedUrls).toHaveLength(3);
		expect(
			requestedUrls.every(
				(url) => new URL(url).origin === "https://us21.api.mailchimp.com",
			),
		).toBe(true);
	});

	it("does not use persisted metadata when the API key suffix is invalid", async () => {
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await mailchimpPublisher.publish({
			operation_id: "test:mailchimp:invalid-key-suffix",
			content: "Newsletter",
			media: [],
			target_options: {
				from_email: "sender@example.test",
				list_id: "list_123",
			},
			account: {
				id: "acc_123",
				platform: "mailchimp",
				access_token: "api-key-without-datacenter",
				refresh_token: null,
				platform_account_id: "mc_123",
				username: "test",
				metadata: { datacenter: "us21" },
			},
		});

		expect(result.success).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Telegram connection ownership", () => {
	it("issues non-stored 48-bit challenge codes with deterministic digests", async () => {
		const code = createTelegramChallengeCode();
		expect(code).toMatch(/^RLAY-[A-F0-9]{12}$/);
		expect(await telegramChallengeId(code)).toBe(
			await telegramChallengeId(code),
		);
		expect(await telegramChallengeId(code)).not.toContain(code);
	});
});
