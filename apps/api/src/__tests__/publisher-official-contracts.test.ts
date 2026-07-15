import { afterEach, describe, expect, it } from "bun:test";
import { beehiivPublisher } from "../publishers/beehiiv";
import { blueskyPublisher } from "../publishers/bluesky";
import { convertkitPublisher } from "../publishers/convertkit";
import {
	discordPublisher,
	getDiscordEmbedTextLength,
} from "../publishers/discord";
import { facebookPublisher } from "../publishers/facebook";
import { instagramPublisher } from "../publishers/instagram";
import { classifyMedia, linkedinPublisher } from "../publishers/linkedin";
import { listmonkPublisher } from "../publishers/listmonk";
import { mastodonPublisher } from "../publishers/mastodon";
import { pinterestPublisher } from "../publishers/pinterest";
import { smsPublisher } from "../publishers/sms";
import { telegramPublisher } from "../publishers/telegram";
import {
	countThreadsCharacters,
	threadsPublisher,
} from "../publishers/threads";
import {
	parseTikTokStatusResponse,
	tiktokPublisher,
} from "../publishers/tiktok";
import {
	getTwitterMediaStatusUrl,
	twitterPublisher,
} from "../publishers/twitter";
import type {
	MediaAttachment,
	Publisher,
	PublishRequest,
} from "../publishers/types";
import { whatsappPublisher } from "../publishers/whatsapp";
import { youtubePublisher } from "../publishers/youtube";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(
	platform: PublishRequest["account"]["platform"],
	options: {
		content?: string;
		media?: MediaAttachment[];
		targetOptions?: Record<string, unknown>;
		accessToken?: string;
		platformAccountId?: string;
		metadata?: Record<string, unknown>;
	} = {},
): PublishRequest {
	return {
		operation_id: "official-contract-test",
		content: options.content ?? "hello",
		media: options.media ?? [],
		target_options: options.targetOptions ?? {},
		account: {
			id: "account-test",
			platform,
			access_token: options.accessToken ?? "test-token",
			refresh_token: null,
			platform_account_id: options.platformAccountId ?? "user-123",
			username: "relaytest",
			metadata: options.metadata,
		},
	};
}

function images(count: number): MediaAttachment[] {
	return Array.from({ length: count }, (_, index) => ({
		url: `https://cdn.example.test/image-${index}.jpg`,
		type: "image" as const,
	}));
}

describe("official publisher contract validation", () => {
	it("rejects unsupported attachment counts and combinations before network I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const cases: Array<{
			publisher: Publisher;
			request: PublishRequest;
			code: string;
		}> = [
			{
				publisher: pinterestPublisher,
				request: request("pinterest", {
					media: [{ url: "https://cdn.example.test/video.mp4", type: "video" }],
					targetOptions: { board_id: "board-1" },
				}),
				code: "COVER_IMAGE_REQUIRED",
			},
			{
				publisher: instagramPublisher,
				request: request("instagram", { media: images(11) }),
				code: "CONTENT_ERROR",
			},
			{
				publisher: threadsPublisher,
				request: request("threads", { media: images(21) }),
				code: "CONTENT_ERROR",
			},
			{
				publisher: youtubePublisher,
				request: request("youtube", {
					media: [
						{ url: "https://cdn.example.test/one.mp4", type: "video" },
						{ url: "https://cdn.example.test/two.mp4", type: "video" },
					],
				}),
				code: "TOO_MANY_VIDEOS",
			},
			{
				publisher: youtubePublisher,
				request: request("youtube", {
					media: [
						{ url: "https://cdn.example.test/video.mp4", type: "video" },
						{ url: "https://cdn.example.test/one.jpg", type: "image" },
						{ url: "https://cdn.example.test/two.jpg", type: "image" },
					],
				}),
				code: "TOO_MANY_MEDIA",
			},
			{
				publisher: twitterPublisher,
				request: request("twitter", {
					media: [
						{ url: "https://cdn.example.test/photo.jpg", type: "image" },
						{ url: "https://cdn.example.test/video.mp4", type: "video" },
					],
				}),
				code: "CONTENT_ERROR",
			},
			{
				publisher: blueskyPublisher,
				request: request("bluesky", { media: images(5) }),
				code: "CONTENT_ERROR",
			},
			{
				publisher: mastodonPublisher,
				request: request("mastodon", {
					media: [
						{ url: "https://cdn.example.test/report.pdf", type: "document" },
					],
				}),
				code: "UNSUPPORTED_MEDIA_TYPE",
			},
			{
				publisher: linkedinPublisher,
				request: request("linkedin", { media: images(21) }),
				code: "CONTENT_ERROR",
			},
			{
				publisher: telegramPublisher,
				request: request("telegram", { media: images(11) }),
				code: "TOO_MANY_MEDIA",
			},
			{
				publisher: whatsappPublisher,
				request: request("whatsapp", {
					media: images(2),
					targetOptions: { to: "15551234567" },
				}),
				code: "TOO_MANY_MEDIA",
			},
			{
				publisher: whatsappPublisher,
				request: request("whatsapp", {
					media: [
						{ url: "https://cdn.example.test/animation.gif", type: "gif" },
					],
					targetOptions: { to: "15551234567" },
				}),
				code: "UNSUPPORTED_MEDIA_TYPE",
			},
			{
				publisher: smsPublisher,
				request: request("sms", {
					content: "x".repeat(1601),
					targetOptions: {
						from_number: "+15550000000",
						phone_numbers: ["+15551111111"],
					},
				}),
				code: "CONTENT_TOO_LONG",
			},
			{
				publisher: facebookPublisher,
				request: request("facebook", {
					media: [
						{ url: "https://cdn.example.test/one.mp4", type: "video" },
						{ url: "https://cdn.example.test/two.mp4", type: "video" },
					],
					targetOptions: { content_type: "reel" },
				}),
				code: "VIDEO_REQUIRED",
			},
			{
				publisher: discordPublisher,
				request: request("discord", {
					media: images(11),
					accessToken: "https://discord.com/api/webhooks/id/token",
				}),
				code: "TOO_MANY_MEDIA",
			},
			{
				publisher: tiktokPublisher,
				request: request("tiktok", {
					media: [
						{ url: "https://cdn.example.test/report.pdf", type: "document" },
					],
				}),
				code: "UNSUPPORTED_MEDIA_TYPE",
			},
		];

		for (const testCase of cases) {
			const result = await testCase.publisher.publish(testCase.request);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe(testCase.code);
		}
		expect(fetchCalls).toBe(0);
	});

	it("uses beehiiv confirmed status and email_settings when scheduling", async () => {
		let createBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			if (init?.method === "POST") {
				createBody = JSON.parse(String(init.body));
				return Response.json({ data: { id: "post-1" } });
			}
			return Response.json({
				data: { web_url: "https://newsletter.example/post" },
			});
		}) as unknown as typeof fetch;

		const result = await beehiivPublisher.publish(
			request("beehiiv", {
				targetOptions: {
					subject: "Subject",
					preview_text: "Preview",
					scheduled_at: "2026-08-01T10:00:00Z",
				},
				metadata: { publication_id: "publication-1" },
			}),
		);

		expect(result.success).toBe(true);
		expect(createBody).toMatchObject({
			status: "confirmed",
			scheduled_at: "2026-08-01T10:00:00Z",
			email_settings: {
				email_subject_line: "Subject",
				email_preview_text: "Preview",
			},
		});
	});

	it("uses Kit v4's API-key header and preview_text field", async () => {
		let sentHeaders: Headers | undefined;
		let sentBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input, init) => {
			sentHeaders = new Headers(init?.headers);
			sentBody = JSON.parse(String(init?.body));
			return Response.json({
				broadcast: { id: 42, public_url: "https://kit.example/broadcast" },
			});
		}) as typeof fetch;

		const result = await convertkitPublisher.publish(
			request("convertkit", {
				targetOptions: {
					preview_text: "Preview",
					public: true,
					published_at: "2026-08-01T10:00:00Z",
				},
			}),
		);

		expect(result.platform_url).toBe("https://kit.example/broadcast");
		expect(sentHeaders?.get("X-Kit-Api-Key")).toBe("test-token");
		expect(sentHeaders?.get("Authorization")).toBeNull();
		expect(sentBody?.preview_text).toBe("Preview");
		expect(sentBody?.public).toBe(true);
		expect(sentBody?.published_at).toBe("2026-08-01T10:00:00Z");
		expect(sentBody?.description).toBeUndefined();
		expect(Date.parse(String(sentBody?.send_at))).toBeGreaterThan(
			Date.now() + 50_000,
		);
	});

	it("puts listmonk send_at on campaign creation and only status on transition", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return bodies.length === 1
				? Response.json({ data: { id: 7 } })
				: Response.json({});
		}) as typeof fetch;

		const result = await listmonkPublisher.publish(
			request("listmonk", {
				targetOptions: {
					list_id: 1,
					send_at: "2026-08-01T10:00:00Z",
					headers: { "X-Campaign": "relay" },
				},
				metadata: { instance_url: "https://8.8.8.8" },
			}),
		);

		expect(result.success).toBe(true);
		expect(bodies[0]).toMatchObject({
			send_at: "2026-08-01T10:00:00Z",
			headers: [{ "X-Campaign": "relay" }],
		});
		expect(bodies[1]).toEqual({ status: "scheduled" });
	});

	it("counts Threads emoji by UTF-8 bytes and rejects over-limit text before I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		expect(countThreadsCharacters("a".repeat(500))).toBe(500);
		expect(countThreadsCharacters("😀".repeat(125))).toBe(500);
		expect(countThreadsCharacters(`${"a".repeat(496)}😀`)).toBe(500);
		expect(countThreadsCharacters("👨‍👩‍👧‍👦")).toBe(
			new TextEncoder().encode("👨‍👩‍👧‍👦").byteLength,
		);

		const result = await threadsPublisher.publish(
			request("threads", { content: "😀".repeat(126) }),
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("CONTENT_TOO_LONG");
		expect(fetchCalls).toBe(0);
	});

	it("routes LinkedIn GIFs through Images and builds X's documented STATUS query", () => {
		expect(
			classifyMedia([
				{ url: "https://cdn.example.test/animation.gif", type: "gif" },
			]),
		).toBe("image");

		const statusUrl = getTwitterMediaStatusUrl("1880028106020515840");
		expect(statusUrl.pathname).toBe("/2/media/upload");
		expect(statusUrl.searchParams.get("command")).toBe("STATUS");
		expect(statusUrl.searchParams.get("media_id")).toBe("1880028106020515840");
	});

	it("validates malformed Discord embeds as content errors instead of throwing TypeError", async () => {
		expect(() =>
			getDiscordEmbedTextLength([{ title: "valid", footer: {} }]),
		).toThrow("footer.text must be a string");

		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;
		const result = await discordPublisher.publish(
			request("discord", {
				accessToken: "https://discord.com/api/webhooks/id/token",
				targetOptions: { embeds: [{ footer: {} }] },
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("CONTENT_ERROR");
		expect(fetchCalls).toBe(0);
	});

	it("accepts Pinterest's documented video key-frame cover alternative", async () => {
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			requestedUrls.push(String(input));
			return Response.json(
				{ message: "stop after validation" },
				{ status: 400 },
			);
		}) as unknown as typeof fetch;

		const result = await pinterestPublisher.publish(
			request("pinterest", {
				media: [{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				targetOptions: {
					board_id: "board-1",
					cover_image_key_frame_time: 3,
				},
			}),
		);

		expect(requestedUrls).toEqual(["https://api.pinterest.com/v5/media"]);
		expect(result.error?.code).not.toBe("COVER_IMAGE_REQUIRED");
	});

	it("preserves TikTok int64 post ids exactly", () => {
		const status = parseTikTokStatusResponse(
			'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7399999999999999999]},"error":{"code":"ok"}}',
		);
		expect(status.data?.publicaly_available_post_id).toEqual([
			"7399999999999999999",
		]);
	});
});
