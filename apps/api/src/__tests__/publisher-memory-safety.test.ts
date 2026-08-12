import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
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
	"tiktok.ts",
	"twitter.ts",
	"youtube.ts",
];

const KNOWN_LENGTH_STREAM_FILES = [
	"bluesky.ts",
	"facebook.ts",
	"linkedin.ts",
	"snapchat.ts",
	"tiktok.ts",
	"twitter.ts",
	"youtube.ts",
	"../lib/multipart-stream.ts",
];

const PUBLISHER_SOURCE_FILES = Array.from(
	new Bun.Glob("*.ts").scanSync({
		cwd: `${import.meta.dir}/../publishers`,
		absolute: true,
	}),
);

const ALLOWED_NON_PROVIDER_BODY_READS = new Map<string, string[]>([
	["durable-objects/post-updates.ts", ["request.json()"]],
	["middleware/idempotency.ts", ["c.req.arrayBuffer()"]],
	["middleware/usage-tracking.ts", ["file.text()"]],
	["routes/ideas.ts", ["file.arrayBuffer()"]],
	["routes/posts.ts", ["file.text()"]],
	["routes/public-growth.ts", ["c.req.json()"]],
]);

describe("publisher isolate memory guards", () => {
	it("bounds every publisher response body before materializing it", async () => {
		for (const filename of PUBLISHER_SOURCE_FILES) {
			const source = await Bun.file(filename).text();
			expect(source, filename).not.toMatch(/\.(?:json|text)\s*\(\s*\)/);
		}
	});

	it("bounds provider and control-plane responses outside publishers", async () => {
		const sourceRoot = new URL("../", import.meta.url).pathname.replace(
			/\/$/,
			"",
		);
		const files = Array.from(
			new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, absolute: true }),
		).filter(
			(filename) =>
				!filename.includes("/__tests__/") &&
				!filename.includes("/publishers/") &&
				!filename.endsWith("/lib/fetch-public-url.ts"),
		);

		for (const filename of files) {
			const relativePath = relative(sourceRoot, filename);
			let source = await Bun.file(filename).text();
			for (const allowed of ALLOWED_NON_PROVIDER_BODY_READS.get(relativePath) ??
				[]) {
				source = source.replace(allowed, "allowedBoundedBodyRead()");
			}
			expect(source, relativePath).not.toMatch(
				/\.(?:json|text|arrayBuffer|blob)\s*\(\s*\)/,
			);
		}
	});

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
