import { describe, expect, it } from "bun:test";
import {
	compatibleMediaItems,
	formatMediaSize,
	type MediaLibraryItem,
	mediaAcceptForKind,
	mediaMatchesKind,
} from "./media-library";

describe("automation media library", () => {
	it("matches only server-supported MIME types for each block kind", () => {
		expect(mediaMatchesKind("image", "image/png")).toBe(true);
		expect(mediaMatchesKind("image", "image/svg+xml")).toBe(false);
		expect(mediaMatchesKind("video", "video/quicktime")).toBe(true);
		expect(mediaMatchesKind("audio", "audio/ogg; codecs=opus")).toBe(true);
		expect(mediaMatchesKind("file", "application/pdf")).toBe(true);
		expect(mediaMatchesKind("file", "", "report.PDF")).toBe(true);
		expect(mediaMatchesKind("file", "application/zip", "report.zip")).toBe(
			false,
		);
	});

	it("returns only compatible library rows with a usable URL", () => {
		const items: MediaLibraryItem[] = [
			{
				id: "med_image",
				filename: "photo.png",
				mime_type: "image/png",
				original_available: true,
				workspace_id: null,
				size: 1_500,
				url: "https://media.example/photo.png",
				created_at: "2026-08-08T00:00:00.000Z",
			},
			{
				id: "med_video",
				filename: "clip.mp4",
				mime_type: "video/mp4",
				original_available: true,
				workspace_id: "ws_a",
				size: 2_000,
				url: "https://media.example/clip.mp4",
				created_at: "2026-08-08T00:00:00.000Z",
			},
			{
				id: "med_expired",
				filename: "expired.png",
				mime_type: "image/png",
				original_available: true,
				workspace_id: null,
				size: 3_000,
				url: null,
				created_at: "2026-08-08T00:00:00.000Z",
			},
			{
				id: "med_thumbnail_only",
				filename: "old.png",
				mime_type: "image/png",
				original_available: false,
				workspace_id: null,
				size: 4_000,
				url: "https://thumbs.example/old.avif",
				created_at: "2026-08-08T00:00:00.000Z",
			},
			{
				id: "med_ws_a",
				filename: "workspace-a.png",
				mime_type: "image/png",
				original_available: true,
				workspace_id: "ws_a",
				size: 5_000,
				url: "https://media.example/workspace-a.png",
				created_at: "2026-08-08T00:00:00.000Z",
			},
			{
				id: "med_ws_b",
				filename: "workspace-b.png",
				mime_type: "image/png",
				original_available: true,
				workspace_id: "ws_b",
				size: 6_000,
				url: "https://media.example/workspace-b.png",
				created_at: "2026-08-08T00:00:00.000Z",
			},
		];

		expect(
			compatibleMediaItems(items, "image", "ws_a").map((item) => item.id),
		).toEqual(["med_image", "med_ws_a"]);
		expect(
			compatibleMediaItems(items, "image", null).map((item) => item.id),
		).toEqual(["med_image"]);
	});

	it("exposes constrained browser accept filters and readable sizes", () => {
		expect(mediaAcceptForKind("file")).toContain("application/pdf");
		expect(mediaAcceptForKind("image")).not.toContain("image/*");
		expect(formatMediaSize(999)).toBe("999 B");
		expect(formatMediaSize(1_500)).toBe("1.5 KB");
		expect(formatMediaSize(2_000_000)).toBe("2.0 MB");
	});
});
