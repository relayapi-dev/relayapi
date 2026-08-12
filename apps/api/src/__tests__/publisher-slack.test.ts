import { afterEach, describe, expect, it } from "bun:test";
import { getPublisher } from "../publishers";
import { slackPublisher } from "../publishers/slack";
import type { PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;
const WEBHOOK_URL =
	"https://hooks.slack.com/services/T123456/B123456/secret_token";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(targetOptions: Record<string, unknown> = {}): PublishRequest {
	return {
		operation_id: "slack-publisher-test",
		content: "hello Slack",
		media: [],
		target_options: targetOptions,
		account: {
			id: "account-slack",
			platform: "slack",
			access_token: WEBHOOK_URL,
			refresh_token: null,
			platform_account_id: "T123456:B123456",
			username: "T123456",
		},
	};
}

function dnsResponse(input: Parameters<typeof fetch>[0]): Response | null {
	const url = new URL(String(input));
	if (
		url.origin !== "https://dns.google" &&
		url.origin !== "https://cloudflare-dns.com"
	) {
		return null;
	}
	const type = url.searchParams.get("type");
	return Response.json({
		Status: 0,
		Answer: type === "A" ? [{ type: 1, data: "8.8.8.8" }] : [],
	});
}

describe("Slack incoming-webhook publisher", () => {
	it("is registered and confirms a documented plain-text ok response without inventing a message ID", async () => {
		let sentPayload: Record<string, unknown> | undefined;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const dns = dnsResponse(input);
			if (dns) return dns;
			expect(String(input)).toBe(WEBHOOK_URL);
			sentPayload = JSON.parse(String(init?.body));
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch;

		const result = await slackPublisher.publish({
			...request({
				thread_ts: "1712345678.123456",
				unfurl_links: false,
				media: [
					{
						url: "https://cdn.example.test/image.png",
						type: "image",
						alt_text: "Release diagram",
					},
					{
						url: "https://cdn.example.test/report.pdf",
						type: "document",
					},
				],
			}),
		});

		expect(getPublisher("slack")).toBe(slackPublisher);
		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBeUndefined();
		expect(result.provider_outcome).toEqual({
			disposition: "published",
			provider_state: "ok",
			resource_id_unavailable: true,
		});
		expect(sentPayload).toMatchObject({
			text: "hello Slack",
			thread_ts: "1712345678.123456",
			unfurl_links: false,
			blocks: [
				{
					type: "image",
					image_url: "https://cdn.example.test/image.png",
					alt_text: "Release diagram",
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "<https://cdn.example.test/report.pdf|Document attachment 2>",
					},
				},
			],
		});
	});

	it("rejects an unsafe webhook origin before network I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const result = await slackPublisher.publish({
			...request(),
			account: {
				...request().account,
				access_token:
					"https://hooks.slack.com.evil.test/services/T123/B123/secret",
			},
		});

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("PUBLISH_FAILED");
		expect(fetchCalls).toBe(0);
	});

	it("makes a documented 429 safely retryable and honors Retry-After", async () => {
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const dns = dnsResponse(input);
			if (dns) return dns;
			return new Response("rate_limited", {
				status: 429,
				headers: { "retry-after": "3" },
			});
		}) as unknown as typeof fetch;

		const result = await slackPublisher.publish(request());

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("RATE_LIMITED");
		expect(result.outcome?.disposition).toBe("definitive_rejection");
		expect(result.retry).toEqual({
			disposition: "safe_to_retry",
			after_ms: 3000,
		});
	});

	it("keeps a 5xx or oversized response outcome unknown after crossing the provider boundary", async () => {
		for (const providerResponse of [
			new Response("server_error", { status: 500 }),
			new Response("x".repeat(9 * 1024), {
				status: 200,
				headers: { "content-length": String(9 * 1024) },
			}),
		]) {
			globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
				const dns = dnsResponse(input);
				if (dns) return dns;
				return providerResponse;
			}) as unknown as typeof fetch;

			const result = await slackPublisher.publish(request());
			expect(result.success).toBe(false);
			expect(result.retry).toBeUndefined();
			expect(result.provider_outcome?.disposition).toBe("outcome_unknown");
		}
	});

	it("enforces the 50-block message limit before network I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const result = await slackPublisher.publish(
			request({
				blocks: Array.from({ length: 50 }, () => ({ type: "divider" })),
				media: [{ url: "https://cdn.example.test/image.png", type: "image" }],
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("TOO_MANY_BLOCKS");
		expect(fetchCalls).toBe(0);
	});
});
