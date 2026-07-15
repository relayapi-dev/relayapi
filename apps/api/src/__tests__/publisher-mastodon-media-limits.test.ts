import { afterEach, describe, expect, it } from "bun:test";
import { mastodonPublisher } from "../publishers/mastodon";
import type { MediaAttachment, PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;
const INSTANCE_URL = "https://mastodon.example";
const MEDIA_URL =
	"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1/media.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=test";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function publishRequest(media: MediaAttachment[]): PublishRequest {
	return {
		operation_id: "mastodon-media-limit-test",
		content: "test post",
		media,
		target_options: {},
		account: {
			id: "account_1",
			platform: "mastodon",
			access_token: "token",
			refresh_token: null,
			platform_account_id: "user_1",
			username: "relaytest",
			metadata: { instance_url: INSTANCE_URL },
		},
	};
}

function instanceConfiguration(
	imageSizeLimit: unknown,
	videoSizeLimit: unknown,
): Response {
	return Response.json({
		configuration: {
			media_attachments: {
				image_size_limit: imageSizeLimit,
				video_size_limit: videoSizeLimit,
			},
		},
	});
}

describe("Mastodon instance media limits", () => {
	it("falls back to the documented v1 instance endpoint for pre-4.0 servers", async () => {
		const instanceLookups: string[] = [];

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url === `${INSTANCE_URL}/api/v2/instance`) {
				instanceLookups.push("v2");
				return new Response(null, { status: 404 });
			}
			if (url === `${INSTANCE_URL}/api/v1/instance`) {
				instanceLookups.push("v1");
				return instanceConfiguration(8, 16);
			}
			if (url === MEDIA_URL) {
				return new Response(new Uint8Array(5), {
					headers: {
						"content-length": "5",
						"content-type": "image/png",
					},
				});
			}
			if (url === `${INSTANCE_URL}/api/v2/media`) {
				await new Response(init?.body as BodyInit).arrayBuffer();
				return Response.json({ id: "media_1", url: null });
			}
			if (url === `${INSTANCE_URL}/api/v1/statuses`) {
				return Response.json({
					id: "status_1",
					url: `${INSTANCE_URL}/@relaytest/status_1`,
					account: { username: "relaytest" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await mastodonPublisher.publish(
			publishRequest([{ url: MEDIA_URL, type: "image" }]),
		);

		expect(result.success).toBe(true);
		expect(instanceLookups).toEqual(["v2", "v1"]);
	});

	it("uses the advertised image limit before uploading source bytes", async () => {
		let instanceLookups = 0;
		let mediaUploads = 0;

		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === `${INSTANCE_URL}/api/v2/instance`) {
				instanceLookups++;
				return instanceConfiguration(4, 8);
			}
			if (url === MEDIA_URL) {
				return new Response(new Uint8Array(5), {
					headers: {
						"content-length": "5",
						"content-type": "image/png",
					},
				});
			}
			if (url === `${INSTANCE_URL}/api/v2/media`) {
				mediaUploads++;
				return Response.json({ id: "media_1", url: null });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await mastodonPublisher.publish(
			publishRequest([{ url: MEDIA_URL, type: "image" }]),
		);

		expect(result.success).toBe(false);
		expect(result.error?.message).toContain("exceeding the 4-byte limit");
		expect(instanceLookups).toBe(1);
		expect(mediaUploads).toBe(0);
	});

	it("uses the advertised video limit and fetches configuration only once", async () => {
		let instanceLookups = 0;
		let mediaFetches = 0;
		let uploadedBytes = 0;

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url === `${INSTANCE_URL}/api/v2/instance`) {
				instanceLookups++;
				return instanceConfiguration(4, 8);
			}
			if (url === MEDIA_URL) {
				mediaFetches++;
				return new Response(new Uint8Array(5), {
					headers: {
						"content-length": "5",
						"content-type": "video/mp4",
					},
				});
			}
			if (url === `${INSTANCE_URL}/api/v2/media`) {
				uploadedBytes = (
					await new Response(init?.body as BodyInit).arrayBuffer()
				).byteLength;
				return Response.json({ id: "media_1", url: null });
			}
			if (url === `${INSTANCE_URL}/api/v1/statuses`) {
				return Response.json({
					id: "status_1",
					url: `${INSTANCE_URL}/@relaytest/status_1`,
					account: { username: "relaytest" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await mastodonPublisher.publish(
			publishRequest([{ url: MEDIA_URL, type: "video" }]),
		);

		expect(result.success).toBe(true);
		expect(instanceLookups).toBe(1);
		expect(mediaFetches).toBe(1);
		expect(uploadedBytes).toBeGreaterThan(5);
	});

	it("rejects invalid advertised limits before fetching media", async () => {
		let mediaFetches = 0;
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === `${INSTANCE_URL}/api/v2/instance`) {
				return instanceConfiguration("4", 8);
			}
			if (url === MEDIA_URL) {
				mediaFetches++;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await mastodonPublisher.publish(
			publishRequest([{ url: MEDIA_URL, type: "image" }]),
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("PLATFORM_ERROR");
		expect(result.error?.message).toContain("must be positive safe integers");
		expect(mediaFetches).toBe(0);
	});

	it("does not fetch instance media configuration for text-only posts", async () => {
		let instanceLookups = 0;
		globalThis.fetch = (async (input) => {
			const url = String(input);
			if (url === `${INSTANCE_URL}/api/v2/instance`) {
				instanceLookups++;
				throw new Error("Unexpected instance configuration lookup");
			}
			if (url === `${INSTANCE_URL}/api/v1/statuses`) {
				return Response.json({
					id: "status_1",
					url: `${INSTANCE_URL}/@relaytest/status_1`,
					account: { username: "relaytest" },
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await mastodonPublisher.publish(publishRequest([]));

		expect(result.success).toBe(true);
		expect(instanceLookups).toBe(0);
	});
});
