import { describe, expect, it } from "bun:test";
import {
	isImageMime,
	isThumbnailable,
	isVideoMime,
	RELAY_THUMBNAIL_HOST,
	thumbnailKeyFor,
	thumbnailUrlFor,
} from "../lib/thumbnails";

describe("thumbnail mime classification", () => {
	it("recognizes raster image types", () => {
		expect(isImageMime("image/jpeg")).toBe(true);
		expect(isImageMime("image/png")).toBe(true);
		expect(isImageMime("image/webp; charset=binary")).toBe(true);
	});

	it("excludes svg (not a raster source) and non-images", () => {
		expect(isImageMime("image/svg+xml")).toBe(false);
		expect(isImageMime("application/pdf")).toBe(false);
		expect(isImageMime(null)).toBe(false);
		expect(isImageMime(undefined)).toBe(false);
	});

	it("recognizes video types", () => {
		expect(isVideoMime("video/mp4")).toBe(true);
		expect(isVideoMime("video/quicktime")).toBe(true);
		expect(isVideoMime("image/png")).toBe(false);
		expect(isVideoMime(null)).toBe(false);
	});

	it("treats images and videos as thumbnailable, audio/pdf not", () => {
		expect(isThumbnailable("image/png")).toBe(true);
		expect(isThumbnailable("video/mp4")).toBe(true);
		expect(isThumbnailable("audio/mpeg")).toBe(false);
		expect(isThumbnailable("application/pdf")).toBe(false);
	});
});

describe("thumbnail keys & urls", () => {
	it("derives an .avif key from the original storage key", () => {
		expect(thumbnailKeyFor("org_1/file_abc/photo.jpg")).toBe(
			"org_1/file_abc/photo.jpg.avif",
		);
	});

	it("builds a public, path-segment-encoded thumbnail url", () => {
		expect(thumbnailUrlFor("org_1/file_abc/photo.jpg")).toBe(
			`https://${RELAY_THUMBNAIL_HOST}/org_1/file_abc/photo.jpg.avif`,
		);
	});

	it("encodes spaces and unsafe characters in each segment", () => {
		const url = thumbnailUrlFor("org_1/file_abc/my photo (1).png");
		expect(url).toBe(
			`https://${RELAY_THUMBNAIL_HOST}/org_1/file_abc/my%20photo%20(1).png.avif`,
		);
		// No raw spaces survive into the URL.
		expect(url).not.toContain(" ");
	});
});
