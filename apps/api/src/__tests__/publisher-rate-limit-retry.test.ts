import { afterEach, describe, expect, it } from "bun:test";
import { redditPublisher } from "../publishers/reddit";
import { telegramPublisher } from "../publishers/telegram";
import { threadsPublisher } from "../publishers/threads";
import { tiktokPublisher } from "../publishers/tiktok";
import { twitterPublisher } from "../publishers/twitter";
import type { PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(
	platform: "reddit" | "telegram" | "threads" | "tiktok" | "twitter",
	targetOptions: Record<string, unknown> = {},
): PublishRequest {
	return {
		operation_id: "publish-test-operation",
		content: "hello",
		media: [],
		target_options: targetOptions,
		account: {
			id: "account-test",
			platform,
			access_token: "test-token",
			refresh_token: null,
			platform_account_id: platform === "telegram" ? "12345" : "user-123",
			username: "relaytest",
		},
	};
}

describe("publisher rate-limit retry safety", () => {
	it("marks a rejected single Telegram API request safe to retry", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{
					ok: false,
					description: "Too Many Requests: retry later",
					parameters: { retry_after: 1 },
				},
				{ status: 429 },
			)) as unknown as typeof fetch;

		const result = await telegramPublisher.publish(request("telegram"));

		expect(result.error?.code).toBe("RATE_LIMITED");
		expect(result.retry).toEqual({
			disposition: "safe_to_retry",
			after_ms: 1_000,
		});
	});

	it("keeps a partially published Twitter thread ambiguous", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1) {
				return Response.json({ data: { id: "tweet-first" } });
			}
			return Response.json({ detail: "Rate limit exceeded" }, { status: 429 });
		}) as unknown as typeof fetch;

		const result = await twitterPublisher.publish(
			request("twitter", {
				thread: [{ content: "first" }, { content: "second" }],
			}),
		);

		expect(requests).toBe(2);
		expect(result.error?.code).toBe("RATE_LIMITED");
		expect(result.retry).toBeUndefined();
	});

	it("allows retry when the first Twitter thread request was rejected", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ detail: "Rate limit exceeded" },
				{ status: 429 },
			)) as unknown as typeof fetch;

		const result = await twitterPublisher.publish(
			request("twitter", { thread: [{ content: "first" }] }),
		);

		expect(result.retry?.disposition).toBe("safe_to_retry");
		expect(result.outcome?.disposition).toBe("definitive_rejection");
	});

	it("distinguishes first-item and partial Threads rejections", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: { code: 190, message: "expired" } },
				{ status: 401 },
			)) as unknown as typeof fetch;
		const firstRejected = await threadsPublisher.publish(
			request("threads", { thread: [{ content: "first" }] }),
		);
		expect(firstRejected.error?.code).toBe("TOKEN_EXPIRED");
		expect(firstRejected.outcome?.disposition).toBe("definitive_rejection");

		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			switch (requests) {
				case 1:
					return Response.json({ id: "container-root" });
				case 2:
					return Response.json({ status: "FINISHED" });
				case 3:
					return Response.json({ id: "thread-root" });
				case 4:
					return Response.json({ id: "thread-root", permalink: "root-url" });
				default:
					return Response.json(
						{ error: { code: 190, message: "expired" } },
						{ status: 401 },
					);
			}
		}) as unknown as typeof fetch;
		const partial = await threadsPublisher.publish(
			request("threads", {
				thread: [{ content: "first" }, { content: "second" }],
			}),
		);
		expect(partial.error?.code).toBe("TOKEN_EXPIRED");
		expect(partial.outcome).toBeUndefined();
	});

	it("marks a rejected single Tweet request safe to retry", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ detail: "Rate limit exceeded" },
				{ status: 429 },
			)) as unknown as typeof fetch;

		const result = await twitterPublisher.publish(request("twitter"));

		expect(result.error?.code).toBe("RATE_LIMITED");
		expect(result.retry?.disposition).toBe("safe_to_retry");
		expect(result.retry).not.toHaveProperty("after_ms");
	});

	it("does not turn a successful Reddit submit with low remaining quota into a retry", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{
					json: {
						errors: [],
						data: {
							id: "reddit-post",
							name: "t3_reddit-post",
							url: "https://reddit.com/r/test/comments/reddit-post",
						},
					},
				},
				{ headers: { "x-ratelimit-remaining": "0" } },
			)) as unknown as typeof fetch;

		const result = await redditPublisher.publish({
			...request("reddit", { subreddit: "test", title: "hello" }),
			content: "body",
		});

		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBe("t3_reddit-post");
		expect(result.retry).toBeUndefined();
	});

	it("retries a rejected TikTok init but not a rate-limited status poll", async () => {
		globalThis.fetch = (async () =>
			new Response(null, { status: 429 })) as unknown as typeof fetch;
		const rejectedInit = await tiktokPublisher.publish({
			...request("tiktok", { privacy_level: "PUBLIC_TO_EVERYONE" }),
			media: [{ url: "https://media.example/video.mp4", type: "video" }],
		});
		expect(rejectedInit.retry?.disposition).toBe("safe_to_retry");

		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1) {
				return Response.json({
					data: { publish_id: "publish-in-flight" },
					error: { code: "ok" },
				});
			}
			return new Response(null, { status: 429 });
		}) as unknown as typeof fetch;
		const ambiguousPoll = await tiktokPublisher.publish({
			...request("tiktok", { privacy_level: "PUBLIC_TO_EVERYONE" }),
			media: [{ url: "https://media.example/video.mp4", type: "video" }],
		});
		expect(ambiguousPoll.error?.code).toBe("RATE_LIMITED");
		expect(ambiguousPoll.retry).toBeUndefined();
	});

	it("does not replay an accepted TikTok job after poll authentication fails", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1) {
				return Response.json({
					data: { publish_id: "publish-in-flight" },
					error: { code: "ok" },
				});
			}
			return new Response(null, { status: 401 });
		}) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish({
			...request("tiktok", { privacy_level: "PUBLIC_TO_EVERYONE" }),
			media: [{ url: "https://media.example/video.mp4", type: "video" }],
		});

		expect(result.error?.code).toBe("PUBLISH_OUTCOME_UNKNOWN");
		expect(result.retry).toBeUndefined();
		expect(result.outcome).toBeUndefined();
	});

	it("keeps an accepted TikTok job unknown when the status API rejects polling", async () => {
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			if (requests === 1) {
				return Response.json({
					data: { publish_id: "publish-in-flight" },
					error: { code: "ok" },
				});
			}
			return Response.json({
				error: {
					code: "internal_error",
					message: "Status is temporarily unavailable",
				},
			});
		}) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish({
			...request("tiktok", { privacy_level: "PUBLIC_TO_EVERYONE" }),
			media: [{ url: "https://media.example/video.mp4", type: "video" }],
		});

		expect(result.error?.code).toBe("PUBLISH_OUTCOME_UNKNOWN");
		expect(result.retry).toBeUndefined();
		expect(result.outcome).toBeUndefined();
	});

	it("does not hammer TikTok posting-frequency rejections", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				error: {
					code: "spam_risk_too_many_posts",
					message: "Post less frequently",
				},
			})) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish({
			...request("tiktok", { privacy_level: "PUBLIC_TO_EVERYONE" }),
			media: [{ url: "https://media.example/video.mp4", type: "video" }],
		});

		expect(result.error?.code).toBe("spam_risk_too_many_posts");
		expect(result.retry).toBeUndefined();
	});
});
