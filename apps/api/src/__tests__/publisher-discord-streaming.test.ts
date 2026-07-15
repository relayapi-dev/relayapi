import { afterEach, describe, expect, it } from "bun:test";
import { discordPublisher } from "../publishers/discord";
import type { PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;
const WEBHOOK_URL = "https://discord.com/api/webhooks/1/token";
const MEDIA_BASE =
	"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1";
const MEDIA_QUERY =
	"X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=test";
const MEDIA_ONE = `${MEDIA_BASE}/one.jpg?${MEDIA_QUERY}`;
const MEDIA_TWO = `${MEDIA_BASE}/two.jpg?${MEDIA_QUERY}`;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(): PublishRequest {
	return {
		operation_id: "discord-stream-test",
		content: "two attachments",
		media: [
			{ url: MEDIA_ONE, type: "image" },
			{ url: MEDIA_TWO, type: "image" },
		],
		target_options: {},
		account: {
			id: "account_1",
			platform: "discord",
			access_token: WEBHOOK_URL,
			refresh_token: null,
			platform_account_id: "channel_1",
			username: "relaytest",
			metadata: null,
		},
	};
}

describe("Discord multipart attachments", () => {
	it("keeps multiple files as native attachments in one streaming request", async () => {
		let multipartBody = "";
		let sourceFetches = 0;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (url === MEDIA_ONE || url === MEDIA_TWO) {
				sourceFetches++;
				return new Response(new Uint8Array([1, 2, 3, 4]), {
					headers: {
						"content-length": "4",
						"content-type": "image/jpeg",
					},
				});
			}
			if (url === `${WEBHOOK_URL}?wait=true`) {
				const bytes = await new Response(init?.body as BodyInit).arrayBuffer();
				multipartBody = new TextDecoder().decode(bytes);
				expect(init?.headers).toMatchObject({
					"Content-Length": String(bytes.byteLength),
				});
				return Response.json({ id: "message_1", channel_id: "channel_1" });
			}
			if (url === WEBHOOK_URL) {
				return Response.json({ guild_id: "guild_1" });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await discordPublisher.publish(request());

		expect(result.success).toBe(true);
		expect(sourceFetches).toBe(2);
		expect(multipartBody).toContain('name="files[0]"; filename="image_0.jpg"');
		expect(multipartBody).toContain('name="files[1]"; filename="image_1.jpg"');
	});
});
