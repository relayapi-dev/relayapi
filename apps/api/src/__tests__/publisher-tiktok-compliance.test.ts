import { afterEach, describe, expect, it } from "bun:test";
import { tiktokPublisher } from "../publishers/tiktok";
import type { ProviderEffect, PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const relayR2Video =
	"https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/relayapi-media/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20260809T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=test";

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
	return {
		operation_id: "tiktok-compliance-test",
		content: "hello",
		media: [{ url: relayR2Video, type: "video", duration_ms: 1_000 }],
		target_options: {
			privacy_level: "SELF_ONLY",
			allow_comment: false,
			allow_duet: false,
			allow_stitch: false,
			brand_content_toggle: false,
			brand_organic_toggle: false,
			content_preview_confirmed: true,
			express_consent_given: true,
			source_mode: "file_upload",
		},
		account: {
			id: "account-test",
			platform: "tiktok",
			access_token: "test-token",
			refresh_token: null,
			platform_account_id: "creator-1",
			username: "creator",
			metadata: null,
		},
		...overrides,
	};
}

function creatorInfo(options: Partial<Record<string, unknown>> = {}): Response {
	return Response.json({
		data: {
			privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
			comment_disabled: false,
			duet_disabled: false,
			stitch_disabled: false,
			max_video_post_duration_sec: 600,
			...options,
		},
		error: { code: "ok" },
	});
}

describe("TikTok Direct Post compliance", () => {
	it("requires explicit creator choices and consent before network I/O", async () => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish(
			request({
				target_options: {
					privacy_level: "SELF_ONLY",
					allow_comment: false,
				},
			}),
		);

		expect(result.error?.code).toBe("VIDEO_INTERACTIONS_REQUIRED");
		expect(fetches).toBe(0);
	});

	it("rejects a stale privacy choice from fresh creator info", async () => {
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
		) => {
			const url = String(input);
			expect(url).toContain("/creator_info/query/");
			return creatorInfo({ privacy_level_options: ["SELF_ONLY"] });
		}) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish(
			request({
				target_options: {
					...request().target_options,
					privacy_level: "PUBLIC_TO_EVERYONE",
				},
			}),
		);

		expect(result.error?.code).toBe("PRIVACY_LEVEL_UNAVAILABLE");
	});

	it("uses bounded FILE_UPLOAD, journals init, and terminalizes private posts", async () => {
		const effects: ProviderEffect[] = [];
		let initBody: Record<string, unknown> | undefined;
		let uploadHeaders: Headers | undefined;
		let uploadBytes: Uint8Array | undefined;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			if (url.includes("/creator_info/query/")) return creatorInfo();
			if (url === relayR2Video) {
				return new Response(new Uint8Array([1, 2, 3, 4]), {
					headers: {
						"Content-Length": "4",
						"Content-Type": "video/mp4",
					},
				});
			}
			if (url.includes("/post/publish/video/init/")) {
				initBody = JSON.parse(String(init?.body));
				return Response.json({
					data: {
						publish_id: "publish-1",
						upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1",
					},
					error: { code: "ok" },
				});
			}
			if (url.startsWith("https://open-upload.tiktokapis.com/")) {
				uploadHeaders = new Headers(init?.headers);
				uploadBytes = new Uint8Array(init?.body as Uint8Array);
				return new Response(null, { status: 201 });
			}
			if (url.includes("/post/publish/status/fetch/")) {
				return Response.json({
					data: { status: "PUBLISH_COMPLETE" },
					error: { code: "ok" },
				});
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as unknown as typeof fetch;

		const result = await tiktokPublisher.publish({
			...request(),
			effect_recorder: {
				effects,
				async record(effect) {
					effects.push(effect);
				},
			},
		});

		expect(initBody).toMatchObject({
			source_info: {
				source: "FILE_UPLOAD",
				video_size: 4,
				chunk_size: 4,
				total_chunk_count: 1,
			},
		});
		expect(uploadHeaders?.get("Content-Range")).toBe("bytes 0-3/4");
		expect(uploadHeaders?.get("Content-Length")).toBe("4");
		expect([...((uploadBytes ?? new Uint8Array()) as Uint8Array)]).toEqual([
			1, 2, 3, 4,
		]);
		expect(effects.map((effect) => effect.name)).toEqual([
			"tiktok_publish_init",
			"tiktok_video_upload",
		]);
		expect(result.provider_outcome?.disposition).toBe("published");
		expect(result.provider_outcome?.resource_id_unavailable).toBe(true);
	});

	it("rejects photo URLs outside immutable verified prefixes", async () => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const base = request();
		const result = await tiktokPublisher.publish({
			...base,
			media: [{ url: "https://customer.example/photo.jpg", type: "image" }],
			target_options: {
				...base.target_options,
				source_mode: "pull_from_url",
			},
		});

		expect(result.error?.code).toBe("TIKTOK_VERIFIED_MEDIA_URL_REQUIRED");
		expect(fetches).toBe(0);
	});
});
