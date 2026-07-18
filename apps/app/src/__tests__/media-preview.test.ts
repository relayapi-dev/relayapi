import { describe, expect, it } from "bun:test";
import { mediaPreviewCandidates } from "@/lib/media-preview";

describe("media preview fallbacks", () => {
	it("prefers the durable preview before the raw provider source", () => {
		expect(
			mediaPreviewCandidates(
				"https://thumbs.relayapi.dev/org_1/post.avif",
				"https://scontent.example/ephemeral.jpg",
			),
		).toEqual([
			"https://thumbs.relayapi.dev/org_1/post.avif",
			"https://scontent.example/ephemeral.jpg",
		]);
	});

	it("deduplicates identical preview and fallback URLs", () => {
		expect(
			mediaPreviewCandidates(
				"https://example/image.jpg",
				"https://example/image.jpg",
			),
		).toEqual(["https://example/image.jpg"]);
	});
});
