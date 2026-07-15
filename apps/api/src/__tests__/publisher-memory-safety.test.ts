import { describe, expect, it } from "bun:test";
import {
	LOCAL_MEDIA_TARGET_PLATFORMS,
	MEDIA_TARGET_CONCURRENCY,
	publishOperationLocallyStreamsMedia,
	TEXT_TARGET_CONCURRENCY,
} from "../services/publisher-runner";

const MEDIA_PUBLISHERS = [
	"bluesky.ts",
	"discord.ts",
	"facebook.ts",
	"linkedin.ts",
	"mastodon.ts",
	"pinterest.ts",
	"reddit.ts",
	"snapchat.ts",
	"twitter.ts",
	"youtube.ts",
];

const KNOWN_LENGTH_STREAM_FILES = [
	"bluesky.ts",
	"facebook.ts",
	"linkedin.ts",
	"snapchat.ts",
	"twitter.ts",
	"youtube.ts",
	"../lib/multipart-stream.ts",
];

describe("publisher isolate memory guards", () => {
	it("does not reintroduce unbounded whole-media Body readers", async () => {
		for (const filename of MEDIA_PUBLISHERS) {
			const source = await Bun.file(
				`${import.meta.dir}/../publishers/${filename}`,
			).text();
			expect(source, filename).not.toMatch(/\.(?:arrayBuffer|blob)\s*\(/);
		}
	});

	it("serializes media targets while retaining text-only parallelism", () => {
		expect(MEDIA_TARGET_CONCURRENCY).toBe(1);
		expect(TEXT_TARGET_CONCURRENCY).toBe(6);
		for (const platform of MEDIA_PUBLISHERS.map((name) => name.slice(0, -3))) {
			expect(LOCAL_MEDIA_TARGET_PLATFORMS.has(platform), platform).toBe(true);
		}
	});

	it("keeps URL-forwarding media modes lightweight", () => {
		const image = [
			{ url: "https://media.example/image.jpg", type: "image" as const },
		];
		const video = [
			{ url: "https://media.example/video.mp4", type: "video" as const },
		];
		expect(publishOperationLocallyStreamsMedia("facebook", image, {})).toBe(
			false,
		);
		expect(publishOperationLocallyStreamsMedia("pinterest", image, {})).toBe(
			false,
		);
		expect(
			publishOperationLocallyStreamsMedia("facebook", video, {
				content_type: "reel",
			}),
		).toBe(true);
		expect(publishOperationLocallyStreamsMedia("pinterest", video, {})).toBe(
			true,
		);
	});

	it("detects media nested in thread target options", () => {
		expect(
			publishOperationLocallyStreamsMedia("twitter", [], {
				thread: [
					{
						content: "one",
						media: [{ url: "https://media.example/image.jpg", type: "image" }],
					},
				],
			}),
		).toBe(true);
	});

	it("prepares every known-length media stream without rejecting chunked sources", async () => {
		for (const filename of KNOWN_LENGTH_STREAM_FILES) {
			const source = await Bun.file(
				`${import.meta.dir}/../publishers/${filename}`,
			).text();
			const consumers =
				source.match(
					/(?:get(?:FixedLength|Chunked)ResponseBody|createYouTubeUploadBody)\s*\(/g,
				)?.length ?? 0;
			const preparations =
				source.match(/ensureResponseContentLength\s*\(/g)?.length ?? 0;
			expect(consumers, filename).toBeGreaterThan(0);
			expect(preparations, filename).toBeGreaterThanOrEqual(consumers);
		}
	});

	it("delivers one publish message per bounded Queue invocation", async () => {
		const config = await Bun.file(
			`${import.meta.dir}/../../wrangler.jsonc`,
		).text();
		const publishConsumer = config.match(
			/"queue": "relayapi-publish",[\s\S]*?"dead_letter_queue": "relayapi-publish-dlq"/,
		)?.[0];
		expect(publishConsumer).toContain('"max_batch_size": 1');
		// Avoid a new global throughput cap. This is a batching guard, not proof of
		// peak isolate memory; production-like load evidence is still required.
		expect(publishConsumer).not.toContain('"max_concurrency"');
	});
});
