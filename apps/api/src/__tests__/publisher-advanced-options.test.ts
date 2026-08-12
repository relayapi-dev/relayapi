import { afterEach, describe, expect, it } from "bun:test";
import { discordPublisher } from "../publishers/discord";
import { facebookPublisher } from "../publishers/facebook";
import { instagramPublisher } from "../publishers/instagram";
import { threadsPublisher } from "../publishers/threads";
import { tiktokPublisher } from "../publishers/tiktok";
import { twitterPublisher } from "../publishers/twitter";
import type { MediaAttachment, PublishRequest } from "../publishers/types";
import {
	DiscordTargetOptions,
	FacebookTargetOptions,
	InstagramTargetOptions,
	ThreadsTargetOptions,
	TikTokTargetOptions,
	TwitterTargetOptions,
} from "../schemas/publisher-options";
import { validatePlatformPostInput } from "../services/platform-post-validation";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
});

function resolveTimersImmediately(): void {
	globalThis.setTimeout = ((handler: (...args: unknown[]) => void) => {
		handler();
		return 0;
	}) as unknown as typeof setTimeout;
}

function request(
	platform: PublishRequest["account"]["platform"],
	options: {
		content?: string;
		media?: MediaAttachment[];
		targetOptions?: Record<string, unknown>;
		accessToken?: string;
		metadata?: Record<string, unknown> | null;
	} = {},
): PublishRequest {
	return {
		operation_id: `advanced-${platform}`,
		content: options.content ?? "hello",
		media: options.media ?? [],
		target_options: options.targetOptions ?? {},
		account: {
			id: `account-${platform}`,
			platform,
			access_token: options.accessToken ?? "provider-token",
			refresh_token: null,
			platform_account_id: "provider-account",
			username: "relaytest",
			metadata: options.metadata,
		},
	};
}

describe("advanced publisher option schemas and preflight", () => {
	it("types the official advanced option objects", () => {
		expect(
			InstagramTargetOptions.safeParse({
				content_type: "reels",
				cover_variant_id: "mder_cover_1",
				trial_params: { graduation_strategy: "SS_PERFORMANCE" },
			}).success,
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"instagram",
				"caption",
				[{ url: "https://cdn.example.test/reel.mp4", type: "video" }],
				{
					content_type: "reels",
					cover_media_id: "med_cover_1",
					cover_variant_id: "mder_cover_1",
				},
			).some((error) => error.code === "AMBIGUOUS_REEL_COVER"),
		).toBe(true);
		expect(
			TikTokTargetOptions.safeParse({ publish_mode: "inbox" }).success,
		).toBe(true);
		expect(
			TikTokTargetOptions.safeParse({ publish_mode: "direct" }).success,
		).toBe(false);
		expect(
			TikTokTargetOptions.safeParse({
				publish_mode: "inbox",
				privacy_level: "SELF_ONLY",
			}).success,
		).toBe(false);
		expect(
			FacebookTargetOptions.safeParse({
				published: false,
				place_id: "123456789012345",
				targeting: { geo_locations: { countries: ["GB"] } },
			}).success,
		).toBe(true);
		expect(
			FacebookTargetOptions.safeParse({ targeting: { age_max: 65 } }).success,
		).toBe(false);
		expect(
			FacebookTargetOptions.safeParse({
				feed_targeting: { age_min: 40, age_max: 20 },
			}).success,
		).toBe(false);
		expect(
			TwitterTargetOptions.safeParse({
				place_id: "place-1",
				sensitive_media_warning: {
					adult_content: false,
					graphic_violence: true,
					other: false,
				},
			}).success,
		).toBe(true);
		expect(
			ThreadsTargetOptions.safeParse({
				poll: { options: ["A", "B"] },
				quote_post_id: "334567890123456789",
				location_id: "445678901234567890",
			}).success,
		).toBe(true);
		expect(
			DiscordTargetOptions.safeParse({
				thread_name: "Launch",
				applied_tags: ["123456789012345678"],
				poll: {
					question: { text: "Ship it?" },
					answers: [
						{ poll_media: { text: "Yes" } },
						{ poll_media: { text: "No" } },
					],
				},
			}).success,
		).toBe(true);
	});

	it("rejects ambiguous or unsupported combinations during shared preflight", () => {
		expect(
			validatePlatformPostInput(
				"instagram",
				"caption",
				[{ url: "https://cdn.example.test/reel.mp4", type: "video" }],
				{
					content_type: "reels",
					cover_url: "https://cdn.example.test/cover.jpg",
					thumb_offset: 100,
				},
			).some((error) => error.code === "AMBIGUOUS_REEL_COVER"),
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"tiktok",
				"caption",
				[{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				{ publish_mode: "inbox", description: "cannot be forwarded" },
			).some((error) => error.code === "VIDEO_INBOX_DESCRIPTION_UNSUPPORTED"),
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"threads",
				"question",
				[{ url: "https://cdn.example.test/image.jpg", type: "image" }],
				{ poll: { options: ["A", "B"] } },
			).some((error) => error.code === "POLL_REQUIRES_TEXT_POST"),
		).toBe(true);
		expect(
			validatePlatformPostInput("discord", "hello", [], {
				thread_id: "thread-1",
				thread_name: "new thread",
			}).some((error) => error.code === "DISCORD_THREAD_CONFLICT"),
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"tiktok",
				"video",
				[{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				{ publish_mode: "inbox", privacy_level: "SELF_ONLY" },
			).some((error) => error.code === "DIRECT_OPTION_WITH_INBOX_MODE"),
		).toBe(true);
	});
});

describe("advanced official provider payloads", () => {
	it("forwards Instagram Trial Reel and custom-cover fields", async () => {
		resolveTimersImmediately();
		let containerBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/provider-account/media")) {
				containerBody = JSON.parse(String(init?.body));
				return Response.json({ id: "container-1" });
			}
			if (url.includes("/container-1?")) {
				return Response.json({ status_code: "FINISHED" });
			}
			if (url.endsWith("/provider-account/media_publish")) {
				return Response.json({ id: "reel-1" });
			}
			if (url.includes("/reel-1?")) {
				return Response.json({ permalink: "https://instagram.test/reel-1" });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await instagramPublisher.publish(
			request("instagram", {
				accessToken: "IGAA-token",
				media: [{ url: "https://cdn.example.test/reel.mp4", type: "video" }],
				targetOptions: {
					content_type: "reels",
					cover_url: "https://cdn.example.test/cover.jpg",
					trial_params: { graduation_strategy: "SS_PERFORMANCE" },
				},
			}),
		);

		expect(result.success).toBe(true);
		expect(containerBody).toMatchObject({
			media_type: "REELS",
			cover_url: "https://cdn.example.test/cover.jpg",
			trial_params: { graduation_strategy: "SS_PERFORMANCE" },
		});
	});

	it("fails closed if a Relay cover selector was not resolved at publish time", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;

		const result = await instagramPublisher.publish(
			request("instagram", {
				accessToken: "IGAA-token",
				media: [{ url: "https://cdn.example.test/reel.mp4", type: "video" }],
				targetOptions: {
					content_type: "reels",
					cover_variant_id: "mder_cover_1",
				},
			}),
		);

		expect(result.error?.code).toBe("COVER_SELECTOR_UNRESOLVED");
		expect(fetchCalls).toBe(0);
	});

	it("uses TikTok's video inbox endpoint without Direct Post fields or creator-info I/O", async () => {
		let initUrl: string | undefined;
		let initBody: Record<string, unknown> | undefined;
		let creatorInfoCalls = 0;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.includes("creator_info")) creatorInfoCalls++;
			if (url.includes("/post/publish/inbox/video/init/")) {
				initUrl = url;
				initBody = JSON.parse(String(init?.body));
				return Response.json({
					data: { publish_id: "inbox-1" },
					error: { code: "ok" },
				});
			}
			if (url.includes("/post/publish/status/fetch/")) {
				return Response.json({
					data: { status: "SEND_TO_USER_INBOX" },
					error: { code: "ok" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await tiktokPublisher.publish(
			request("tiktok", {
				media: [{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				targetOptions: {
					publish_mode: "inbox",
					source_mode: "pull_from_url",
				},
				metadata: {
					tiktok_verified_url_prefixes: ["https://cdn.example.test/"],
				},
			}),
		);

		expect(initUrl).toContain("/post/publish/inbox/video/init/");
		expect(initBody).toEqual({
			source_info: {
				source: "PULL_FROM_URL",
				video_url: "https://cdn.example.test/video.mp4",
			},
		});
		expect(creatorInfoCalls).toBe(0);
		expect(result.provider_outcome).toMatchObject({
			disposition: "awaiting_user_action",
			provider_state: "SEND_TO_USER_INBOX",
		});
	});

	it("uses TikTok MEDIA_UPLOAD for creator-inbox photo posts", async () => {
		let initBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.includes("/post/publish/content/init/")) {
				initBody = JSON.parse(String(init?.body));
				return Response.json({
					data: { publish_id: "photo-inbox-1" },
					error: { code: "ok" },
				});
			}
			if (url.includes("/post/publish/status/fetch/")) {
				return Response.json({
					data: { status: "SEND_TO_USER_INBOX" },
					error: { code: "ok" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await tiktokPublisher.publish(
			request("tiktok", {
				content: "Photo title",
				media: [{ url: "https://cdn.example.test/photo.jpg", type: "image" }],
				targetOptions: {
					publish_mode: "inbox",
					description: "Photo description",
					photo_cover_index: 0,
				},
				metadata: {
					tiktok_verified_url_prefixes: ["https://cdn.example.test/"],
				},
			}),
		);

		expect(initBody).toMatchObject({
			post_mode: "MEDIA_UPLOAD",
			media_type: "PHOTO",
			post_info: { title: "Photo title", description: "Photo description" },
		});
		const photoPostInfo = initBody?.post_info as
			| Record<string, unknown>
			| undefined;
		expect(photoPostInfo?.privacy_level).toBeUndefined();
		expect(result.provider_outcome?.disposition).toBe("awaiting_user_action");
	});

	it("creates an unpublished targeted Facebook image feed post", async () => {
		let feedBody: URLSearchParams | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.includes("/provider-account/photos")) {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					url: "https://cdn.example.test/photo.jpg",
					published: false,
				});
				return Response.json({ id: "photo-1" });
			}
			if (url.includes("/provider-account/feed")) {
				feedBody = new URLSearchParams(String(init?.body));
				return Response.json({ id: "page_post_1" });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await facebookPublisher.publish(
			request("facebook", {
				media: [{ url: "https://cdn.example.test/photo.jpg", type: "image" }],
				targetOptions: {
					published: false,
					place_id: "123456789012345",
					targeting: { geo_locations: { countries: ["GB"] } },
					feed_targeting: { age_min: 18 },
				},
			}),
		);

		expect(feedBody?.get("published")).toBe("false");
		expect(feedBody?.get("place")).toBe("123456789012345");
		expect(JSON.parse(feedBody?.get("targeting") ?? "null")).toEqual({
			geo_locations: { countries: ["GB"] },
		});
		expect(JSON.parse(feedBody?.get("feed_targeting") ?? "null")).toEqual({
			age_min: 18,
		});
		expect(result.provider_outcome?.disposition).toBe("provider_draft");
		expect(result.platform_url).toBeUndefined();
	});

	it("rejects unsupported Facebook targeting fields before provider I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;

		const result = await facebookPublisher.publish(
			request("facebook", {
				targetOptions: {
					targeting: { age_max: 65 },
				},
			}),
		);

		expect(result.error?.code).toBe("INVALID_FACEBOOK_TARGET_OPTIONS");
		expect(fetchCalls).toBe(0);
	});

	it("sends Facebook scheduled Reel state, Unix time, and place", async () => {
		const scheduledAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
		let finishBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.includes("/provider-account/video_reels")) {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				if (body.upload_phase === "start") {
					return Response.json({
						video_id: "video-1",
						upload_url: "https://rupload.facebook.test/video-1",
					});
				}
				finishBody = body;
				return Response.json({ success: true });
			}
			if (url === "https://8.8.8.8/reel.mp4") {
				return new Response(new Uint8Array([1, 2, 3]), {
					headers: {
						"Content-Length": "3",
						"Content-Type": "video/mp4",
					},
				});
			}
			if (url === "https://rupload.facebook.test/video-1") {
				await new Response(init?.body).arrayBuffer();
				return new Response(null, { status: 200 });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await facebookPublisher.publish(
			request("facebook", {
				media: [{ url: "https://8.8.8.8/reel.mp4", type: "video" }],
				targetOptions: {
					content_type: "reel",
					reel_state: "SCHEDULED",
					reel_scheduled_publish_time: scheduledAt,
					place_id: "123456789012345",
				},
			}),
		);

		expect(finishBody).toMatchObject({
			upload_phase: "finish",
			video_id: "video-1",
			video_state: "SCHEDULED",
			place: "123456789012345",
			scheduled_publish_time: Math.floor(Date.parse(scheduledAt) / 1000),
		});
		expect(result.provider_outcome).toMatchObject({
			disposition: "scheduled",
			provider_state: "reel_scheduled",
			next_reconcile_at: scheduledAt,
		});
	});

	it("checks X media metadata before creating a geo-tagged Post", async () => {
		let metadataBody: Record<string, unknown> | undefined;
		let tweetBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url === "https://8.8.8.8/photo.jpg") {
				return new Response(new Uint8Array([1, 2, 3]), {
					headers: {
						"Content-Length": "3",
						"Content-Type": "image/jpeg",
					},
				});
			}
			if (url.endsWith("/media/upload/initialize")) {
				return Response.json({
					data: { id: "media-1", media_key: "3_media-1" },
				});
			}
			if (url.endsWith("/media/upload/media-1/append")) {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/media/upload/media-1/finalize")) {
				return Response.json({ data: { id: "media-1" } });
			}
			if (url.endsWith("/media/metadata")) {
				metadataBody = JSON.parse(String(init?.body));
				return Response.json({ data: { id: "media-1" } });
			}
			if (url.endsWith("/tweets")) {
				tweetBody = JSON.parse(String(init?.body));
				return Response.json({ data: { id: "tweet-1" } });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const warning = {
			adult_content: false,
			graphic_violence: true,
			other: false,
		};
		const result = await twitterPublisher.publish(
			request("twitter", {
				media: [
					{
						url: "https://8.8.8.8/photo.jpg",
						type: "image",
						alt_text: "Accessible photo",
					},
				],
				targetOptions: {
					place_id: "place-1",
					sensitive_media_warning: warning,
				},
			}),
		);

		expect(metadataBody).toEqual({
			id: "media-1",
			metadata: {
				alt_text: { text: "Accessible photo" },
				sensitive_media_warning: warning,
			},
		});
		expect(tweetBody).toMatchObject({ geo: { place_id: "place-1" } });
		expect(result.success).toBe(true);
	});

	it("does not create an X Post when required media metadata is rejected", async () => {
		let tweetCalls = 0;
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === "https://8.8.8.8/photo.jpg") {
				return new Response(new Uint8Array([1]), {
					headers: {
						"Content-Length": "1",
						"Content-Type": "image/jpeg",
					},
				});
			}
			if (url.endsWith("/media/upload/initialize")) {
				return Response.json({
					data: { id: "media-1", media_key: "3_media-1" },
				});
			}
			if (url.endsWith("/media/upload/media-1/append")) {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/media/upload/media-1/finalize")) {
				return Response.json({ data: { id: "media-1" } });
			}
			if (url.endsWith("/media/metadata")) {
				return Response.json({ detail: "invalid metadata" }, { status: 400 });
			}
			if (url.endsWith("/tweets")) tweetCalls++;
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await twitterPublisher.publish(
			request("twitter", {
				media: [
					{
						url: "https://8.8.8.8/photo.jpg",
						type: "image",
						alt_text: "Accessible photo",
					},
				],
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error?.message).toContain("metadata");
		expect(tweetCalls).toBe(0);
	});

	it("does not create an X Post when a 2xx metadata response reports logical errors", async () => {
		let tweetCalls = 0;
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === "https://8.8.8.8/photo.jpg") {
				return new Response(new Uint8Array([1]), {
					headers: {
						"Content-Length": "1",
						"Content-Type": "image/jpeg",
					},
				});
			}
			if (url.endsWith("/media/upload/initialize")) {
				return Response.json({
					data: { id: "media-1", media_key: "3_media-1" },
				});
			}
			if (url.endsWith("/media/upload/media-1/append")) {
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/media/upload/media-1/finalize")) {
				return Response.json({ data: { id: "media-1" } });
			}
			if (url.endsWith("/media/metadata")) {
				return Response.json({
					errors: [{ title: "Invalid metadata", detail: "labels rejected" }],
				});
			}
			if (url.endsWith("/tweets")) {
				tweetCalls++;
				return Response.json({ data: { id: "tweet-1" } });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await twitterPublisher.publish(
			request("twitter", {
				media: [{ url: "https://8.8.8.8/photo.jpg", type: "image" }],
				targetOptions: {
					sensitive_media_warning: {
						adult_content: false,
						graphic_violence: true,
						other: false,
					},
				},
			}),
		);

		expect(result.error?.message).toContain("labels rejected");
		expect(tweetCalls).toBe(0);
	});

	it("maps Discord TTS, polls, and forum-thread fields exactly", async () => {
		let executeUrl: URL | undefined;
		let executeBody: Record<string, unknown> | undefined;
		const recordedEffects: Array<{
			name: string;
			status: "succeeded" | "failed" | "unsupported" | "outcome_unknown";
			provider_id?: string;
		}> = [];
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "POST") {
				executeUrl = url;
				executeBody = JSON.parse(String(init.body));
				return Response.json({
					id: "message-1",
					channel_id: "223456789012345678",
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		const publishRequest = request("discord", {
			accessToken: "https://discord.com/api/webhooks/123/token",
			content: "Vote now",
			targetOptions: {
				tts: true,
				thread_name: "Launch poll",
				applied_tags: ["123456789012345678"],
				poll: {
					question: { text: "Ship it?" },
					answers: [
						{ poll_media: { text: "Yes", emoji: { name: "✅" } } },
						{ poll_media: { text: "No" } },
					],
					duration: 24,
					allow_multiselect: false,
					layout_type: 1,
				},
			},
		});
		publishRequest.effect_recorder = {
			effects: recordedEffects,
			async record(effect) {
				recordedEffects.push(effect);
			},
		};
		const result = await discordPublisher.publish(publishRequest);

		expect(executeUrl?.searchParams.get("wait")).toBe("true");
		expect(executeBody).toMatchObject({
			content: "Vote now",
			tts: true,
			thread_name: "Launch poll",
			applied_tags: ["123456789012345678"],
			poll: {
				question: { text: "Ship it?" },
				answers: [
					{ poll_media: { text: "Yes", emoji: { name: "✅" } } },
					{ poll_media: { text: "No" } },
				],
				duration: 24,
				allow_multiselect: false,
				layout_type: 1,
			},
		});
		expect(result.success).toBe(true);
		expect(recordedEffects).toContainEqual({
			name: "discord_thread_context",
			status: "succeeded",
			provider_id: "223456789012345678",
		});
		expect(result.provider_outcome?.effects).toContainEqual(recordedEffects[0]);
	});

	it("forwards Discord thread_id as a query parameter", async () => {
		let executeUrl: URL | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "POST") {
				executeUrl = url;
				return Response.json({
					id: "message-1",
					channel_id: "223456789012345678",
				});
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;

		await discordPublisher.publish(
			request("discord", {
				accessToken: "https://discord.com/api/webhooks/123/token",
				targetOptions: { thread_id: "223456789012345678" },
			}),
		);
		expect(executeUrl?.searchParams.get("thread_id")).toBe(
			"223456789012345678",
		);
	});

	it("maps Threads poll, quote, and location fields to the container request", async () => {
		resolveTimersImmediately();
		let containerBody: URLSearchParams | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/provider-account/threads")) {
				containerBody = new URLSearchParams(String(init?.body));
				return Response.json({ id: "container-1" });
			}
			if (url.includes("/container-1?")) {
				return Response.json({ status: "FINISHED" });
			}
			if (url.endsWith("/provider-account/threads_publish")) {
				return Response.json({ id: "thread-1" });
			}
			if (url.includes("/thread-1?")) {
				return Response.json({ permalink: "https://threads.test/thread-1" });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as typeof fetch;

		const result = await threadsPublisher.publish(
			request("threads", {
				content: "Pick one",
				targetOptions: {
					poll: { options: ["Alpha", "Beta"] },
					quote_post_id: "334567890123456789",
					location_id: "445678901234567890",
				},
			}),
		);

		expect(containerBody?.get("poll_attachment")).toBe(
			JSON.stringify({ option_a: "Alpha", option_b: "Beta" }),
		);
		expect(containerBody?.get("quote_post_id")).toBe("334567890123456789");
		expect(containerBody?.get("location_id")).toBe("445678901234567890");
		expect(result.success).toBe(true);
	});
});
