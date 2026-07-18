import { describe, expect, it } from "bun:test";
import {
	externalPreviewRetryDelaySeconds,
	externalPreviewSourceCandidates,
	externalPreviewStorageKey,
} from "../services/external-post-sync/previews";

describe("external post durable previews", () => {
	it("uses an organization-prefixed R2 key for tenant cleanup", () => {
		expect(externalPreviewStorageKey("org_1", "xp_1")).toBe(
			"org_1/external-posts/xp_1/preview",
		);
	});

	it("prefers the provider poster and retains one deduplicated raw fallback", () => {
		expect(
			externalPreviewSourceCandidates({
				thumbnailUrl: "https://cdn.example/poster.jpg",
				mediaUrls: [
					"https://cdn.example/poster.jpg",
					"https://cdn.example/video.mp4",
				],
				mediaType: "video",
			}),
		).toEqual([
			{
				url: "https://cdn.example/poster.jpg",
				fallbackMimeType: "image/jpeg",
			},
			{
				url: "https://cdn.example/video.mp4",
				fallbackMimeType: "video/mp4",
			},
		]);
	});

	it("backs off transient failures with a six-hour ceiling", () => {
		expect(externalPreviewRetryDelaySeconds(1)).toBe(60);
		expect(externalPreviewRetryDelaySeconds(4)).toBe(480);
		expect(externalPreviewRetryDelaySeconds(99)).toBe(6 * 60 * 60);
	});
});
