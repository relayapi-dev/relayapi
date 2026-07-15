import { afterEach, describe, expect, it } from "bun:test";
import { twitterPublisher } from "../publishers/twitter";
import type { PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;
const MEDIA_URL =
	"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1/media.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=test";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function streamedMediaResponse(): Response {
	let chunk = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunk === 0) controller.enqueue(new Uint8Array(2).fill(1));
				else if (chunk === 1) controller.enqueue(new Uint8Array(3).fill(2));
				else controller.close();
				chunk++;
			},
		}),
		{
			headers: {
				"content-length": "0",
				"content-type": "image/png",
			},
		},
	);
}

describe("publisher media streaming", () => {
	it("measures a zero-length-declared source and streams its replay through X upload", async () => {
		let mediaFetches = 0;
		let initializedBytes: number | undefined;
		let appendedBytes: number | undefined;

		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url === MEDIA_URL) {
				mediaFetches++;
				return streamedMediaResponse();
			}
			if (url.endsWith("/2/media/upload/initialize")) {
				initializedBytes = (
					JSON.parse(String(init?.body)) as {
						total_bytes: number;
					}
				).total_bytes;
				return Response.json({ data: { id: "media_1", media_key: "key_1" } });
			}
			if (url.endsWith("/2/media/upload/media_1/append")) {
				const form = init?.body as FormData;
				appendedBytes = (form.get("media") as Blob).size;
				return new Response(null, { status: 204 });
			}
			if (url.endsWith("/2/media/upload/media_1/finalize")) {
				return Response.json({ data: { id: "media_1" } });
			}
			if (url.endsWith("/2/tweets")) {
				return Response.json({ data: { id: "tweet_1" } });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const request: PublishRequest = {
			operation_id: "publish-media-stream-test",
			content: "streamed image",
			media: [{ url: MEDIA_URL, type: "image" }],
			target_options: {},
			account: {
				id: "account_1",
				platform: "twitter",
				access_token: "token",
				refresh_token: null,
				platform_account_id: "user_1",
				username: "relaytest",
			},
		};

		const result = await twitterPublisher.publish(request);
		expect(result.success).toBe(true);
		expect(mediaFetches).toBe(2);
		expect(initializedBytes).toBe(5);
		expect(appendedBytes).toBe(5);
	});
});
