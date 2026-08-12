import { afterEach, describe, expect, it } from "bun:test";
import { PLATFORM_LIMITS } from "../config/platform-limits";
import { beehiivPublisher } from "../publishers/beehiiv";
import { blueskyPublisher, resolveBlueskyPdsUrl } from "../publishers/bluesky";
import { facebookPublisher } from "../publishers/facebook";
import { resolveMastodonInstanceUrl } from "../publishers/mastodon";
import { snapchatPublisher } from "../publishers/snapchat";
import { tiktokPublisher } from "../publishers/tiktok";
import type {
	ProviderEffect,
	PublishRequest,
	ReconcileRequest,
} from "../publishers/types";
import { whatsappStatusResult } from "../publishers/whatsapp";
import {
	inferPublisherMediaTypeFromMime,
	inferPublisherMediaTypeFromUrl,
	normalizePublisherMedia,
	PublisherMediaTypeError,
} from "../services/publisher-runner";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("shared publisher capability limits", () => {
	it("matches the implemented media surfaces instead of advertising dead paths", () => {
		expect(PLATFORM_LIMITS.reddit.media.maxImages).toBe(1);
		expect(PLATFORM_LIMITS.youtube.media.maxImages).toBe(1);
		expect(PLATFORM_LIMITS.bluesky.media.maxImageSize).toBe(2_000_000);
		expect(PLATFORM_LIMITS.telegram.media.maxVideos).toBe(10);
		expect(PLATFORM_LIMITS.discord.media.maxVideos).toBe(10);
		expect(PLATFORM_LIMITS.discord.media.maxVideoSize).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});
});

function request(
	platform: PublishRequest["account"]["platform"],
	overrides: Partial<PublishRequest> = {},
): PublishRequest {
	return {
		operation_id: "publisher-remediation-test",
		content: "hello",
		media: [],
		target_options: {},
		account: {
			id: `account-${platform}`,
			platform,
			access_token: "token",
			refresh_token: null,
			platform_account_id: "provider-account",
			username: "relaytest",
		},
		...overrides,
	};
}

function reconcileRequest(
	platform: PublishRequest["account"]["platform"],
	overrides: Partial<ReconcileRequest> = {},
): ReconcileRequest {
	return {
		account: request(platform).account,
		provider_operation_id: "operation-1",
		platform_post_id: null,
		provider_state: null,
		effects: [] as ProviderEffect[],
		...overrides,
	};
}

describe("publisher destination ownership", () => {
	it("requires immutable bare HTTPS Mastodon connection metadata", () => {
		expect(
			resolveMastodonInstanceUrl({ instance_url: "https://mastodon.social/" }),
		).toBe("https://mastodon.social");
		for (const metadata of [
			undefined,
			{ instance_url: "http://mastodon.social" },
			{ instance_url: "https://mastodon.social/path" },
			{ instance_url: "https://mastodon.social/?redirect=evil" },
		]) {
			expect(() => resolveMastodonInstanceUrl(metadata)).toThrow();
		}
	});

	it("requires the connector-verified Bluesky PDS and uses it for session and record writes", async () => {
		expect(resolveBlueskyPdsUrl({ pds_url: "https://pds.example.com/" })).toBe(
			"https://pds.example.com",
		);
		for (const metadata of [
			undefined,
			{ pds_url: "http://pds.example.com" },
			{ pds_url: "https://pds.example.com/xrpc" },
			{ pds_url: "https://pds.example.com/?next=evil" },
		]) {
			expect(() => resolveBlueskyPdsUrl(metadata)).toThrow();
		}

		const did = "did:plc:abcdefghijklmnopqrstuvwxyz";
		const urls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/com.atproto.server.createSession")) {
				return Response.json({
					did,
					handle: "relay.test",
					accessJwt: "jwt",
					refreshJwt: "refresh",
				});
			}
			if (url.endsWith("/com.atproto.repo.createRecord")) {
				return Response.json({
					uri: `at://${did}/app.bsky.feed.post/record-1`,
					cid: "cid-1",
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;

		const result = await blueskyPublisher.publish({
			...request("bluesky"),
			account: {
				...request("bluesky").account,
				platform_account_id: did,
				metadata: { pds_url: "https://8.8.8.8" },
			},
		});

		expect(result.success).toBe(true);
		expect(urls).toEqual([
			"https://8.8.8.8/xrpc/com.atproto.server.createSession",
			"https://8.8.8.8/xrpc/com.atproto.repo.createRecord",
		]);

		globalThis.fetch = (async () => {
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;
		const legacy = await blueskyPublisher.publish(request("bluesky"));
		expect(legacy.error?.code).toBe("ACCOUNT_RECONNECT_REQUIRED");
	});

	it("rejects caller-selected Snapchat profiles and unreconcilable Story publishing before upload", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;
		const base = {
			...request("snapchat"),
			media: [
				{ url: "https://cdn.example.test/image.jpg", type: "image" as const },
			],
			account: {
				...request("snapchat").account,
				platform_account_id: "connected-profile",
				metadata: { snapchat_public_profile_verified: true },
			},
		};
		const legacy = await snapchatPublisher.publish({
			...base,
			account: {
				...base.account,
				metadata: undefined,
			},
			target_options: { content_type: "saved_story" },
		});
		expect(legacy.error?.code).toBe("SNAPCHAT_RECONNECT_REQUIRED");

		const mismatch = await snapchatPublisher.publish({
			...base,
			target_options: {
				profile_id: "other-profile",
				content_type: "saved_story",
			},
		});
		expect(mismatch.error?.code).toBe("PROFILE_ID_MISMATCH");

		const story = await snapchatPublisher.publish({
			...base,
			target_options: { content_type: "story" },
		});
		expect(story.error?.code).toBe("SNAPCHAT_STORY_UNSUPPORTED");
		expect(fetchCalls).toBe(0);
	});
});

describe("provider lifecycle reconciliation", () => {
	it("terminalizes TikTok PUBLISH_COMPLETE even when no public post ID is available", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				data: { status: "PUBLISH_COMPLETE" },
				error: { code: "ok" },
			})) as unknown as typeof fetch;
		const result = await tiktokPublisher.reconcile?.(
			reconcileRequest("tiktok", {
				provider_operation_id: "publish-id",
			}),
		);
		expect(result?.success).toBe(true);
		expect(result?.provider_outcome).toMatchObject({
			disposition: "published",
			provider_operation_id: "publish-id",
			provider_state: "PUBLISH_COMPLETE",
			resource_id_unavailable: true,
		});
	});

	it("maps Facebook asynchronous video processing, ready, and failure states", async () => {
		for (const [status, expected] of [
			[{ video_status: "processing" }, "processing"],
			[{ video_status: "ready" }, "published"],
			[{ video_status: "error" }, "failed"],
		] as const) {
			globalThis.fetch = (async () =>
				Response.json({
					id: "video-1",
					permalink_url: "https://facebook.example/video-1",
					status,
				})) as unknown as typeof fetch;
			const result = await facebookPublisher.reconcile?.(
				reconcileRequest("facebook", {
					provider_operation_id: "video-1",
				}),
			);
			expect(result?.provider_outcome?.disposition).toBe(expected);
		}
	});

	it("reconciles Beehiiv's accepted build to a published post", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				data: {
					id: "post-1",
					status: "confirmed",
					web_url: "https://newsletter.example/post-1",
				},
			})) as unknown as typeof fetch;
		const result = await beehiivPublisher.reconcile?.(
			reconcileRequest("beehiiv", {
				provider_operation_id: "post-1",
			}),
		);
		expect(result?.provider_outcome?.disposition).toBe("published");
		expect(result?.platform_post_id).toBe("post-1");
	});

	it("normalizes WhatsApp webhook delivery states", () => {
		expect(
			whatsappStatusResult("wamid.1", "sent").provider_outcome?.disposition,
		).toBe("accepted");
		expect(
			whatsappStatusResult("wamid.1", "delivered").provider_outcome
				?.disposition,
		).toBe("delivered");
		expect(
			whatsappStatusResult("wamid.1", "failed", {
				code: 131000,
				message: "Delivery failed",
			}).error?.code,
		).toBe("WHATSAPP_131000");
	});
});

describe("global publisher media normalization", () => {
	it("infers URL and MIME types, preserves explicit types, and ignores inactive target aliases", async () => {
		expect(
			inferPublisherMediaTypeFromUrl("https://cdn.test/photo.JPG?x=1"),
		).toBe("image");
		expect(inferPublisherMediaTypeFromMime("image/gif; charset=binary")).toBe(
			"gif",
		);

		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("explicit and extension types must not be probed");
		}) as unknown as typeof fetch;
		const normalized = await normalizePublisherMedia(
			[
				{ url: "https://cdn.test/photo.jpg" },
				{ url: "https://cdn.test/no-extension", type: "document" },
			],
			{
				twitter: {
					media: [{ url: "https://cdn.test/clip.mp4" }],
				},
				inactive: {
					media: [{ url: "not-a-url" }],
				},
			},
			new Set(["twitter"]),
		);
		expect(normalized.mediaItems.map((item) => item.type)).toEqual([
			"image",
			"document",
		]);
		const twitterOptions = normalized.targetOptions?.twitter;
		expect(
			(twitterOptions?.media as Array<{ type: string }> | undefined)?.[0]?.type,
		).toBe("video");
		expect(normalized.targetOptions?.inactive).toEqual({
			media: [{ url: "not-a-url" }],
		});
		expect(fetchCalls).toBe(0);
	});

	it("probes a safe ambiguous URL and rejects an unsupported response MIME", async () => {
		globalThis.fetch = (async () =>
			new Response(null, {
				headers: { "content-type": "video/mp4" },
			})) as unknown as typeof fetch;
		const inferred = await normalizePublisherMedia(
			[{ url: "https://8.8.8.8/media" }],
			null,
		);
		expect(inferred.mediaItems[0]?.type).toBe("video");

		globalThis.fetch = (async () =>
			new Response(null, {
				headers: { "content-type": "application/octet-stream" },
			})) as unknown as typeof fetch;
		try {
			await normalizePublisherMedia([{ url: "https://8.8.8.8/opaque" }], null);
			throw new Error("Expected ambiguous media to be rejected");
		} catch (error) {
			expect(error).toBeInstanceOf(PublisherMediaTypeError);
			expect((error as PublisherMediaTypeError).code).toBe(
				"MEDIA_TYPE_AMBIGUOUS",
			);
		}
	});
});
