import type { Env } from "../types";

/**
 * Hyper-optimized post preview thumbnails.
 *
 * We keep ONE tiny WebP per media item in a separate, never-expiring R2 bucket
 * (THUMBNAIL_BUCKET) so card/list/calendar previews survive after the full-res
 * original is purged by the relayapi-media lifecycle rule. Generation runs
 * off the request path in the R2-event queue consumer (covers both the direct
 * and presigned upload routes), using the Cloudflare Images binding for stills
 * and the Media Transformations binding for a single video poster frame — both
 * operate directly on R2 bytes, no public URL or presign required.
 *
 * Images binding: https://developers.cloudflare.com/images/optimization/binding/
 * Media binding:  https://developers.cloudflare.com/stream/transform-videos/bindings/
 */

/** Public custom domain mapped to THUMBNAIL_BUCKET. Stable, CDN-cacheable URLs. */
export const RELAY_THUMBNAIL_HOST = "thumbs.relayapi.dev";

// Aggressive defaults: these are tiny card/list previews, never the displayed
// asset, so we optimize hard for bytes. AVIF beats WebP by ~30-50% at equal
// quality; a small width + low quality + flattening animation to a single frame
// pushes typical output to ~4-10KB. Dial these if you want even smaller / sharper.
/** Output format — AVIF is the most byte-efficient widely-supported format. */
const THUMBNAIL_FORMAT = "image/avif";
/** File extension matching THUMBNAIL_FORMAT (used in the object key + URL). */
const THUMBNAIL_EXT = "avif";
/** Long edge of the preview, in px. Covers the largest card (~208px) on retina-ish. */
const THUMBNAIL_WIDTH = 320;
/** Encoder quality (1-100). Low — visually fine at thumbnail scale, minimal bytes. */
const THUMBNAIL_QUALITY = 45;
/** Images binding input ceiling (raw bytes). Larger originals are skipped. */
const IMAGES_MAX_INPUT_BYTES = 20 * 1024 * 1024;

export function isImageMime(mime: string | null | undefined): boolean {
	if (!mime) return false;
	const m = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	// SVG isn't a raster source for resize; skip it (rendered fine inline anyway).
	return m.startsWith("image/") && m !== "image/svg+xml";
}

export function isVideoMime(mime: string | null | undefined): boolean {
	if (!mime) return false;
	return (mime.split(";")[0]?.trim().toLowerCase() ?? "").startsWith("video/");
}

/** Whether we can generate a meaningful preview for this mime (image or video). */
export function isThumbnailable(mime: string | null | undefined): boolean {
	return isImageMime(mime) || isVideoMime(mime);
}

/** Thumbnail object key in THUMBNAIL_BUCKET — original key + format extension. */
export function thumbnailKeyFor(storageKey: string): string {
	return `${storageKey}.${THUMBNAIL_EXT}`;
}

/** Stable public URL for a thumbnail, path-segment encoded for safe <img src>. */
export function thumbnailUrlFor(storageKey: string): string {
	const encoded = thumbnailKeyFor(storageKey)
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://${RELAY_THUMBNAIL_HOST}/${encoded}`;
}

/**
 * Generate and store a tiny, aggressively-optimized AVIF preview for an uploaded
 * original, returning the thumbnail key + URL, or null when generation isn't
 * possible (unsupported type, missing binding, original absent, or oversized
 * input). Best-effort — callers treat null as "no thumbnail" and never fail the
 * upload over it.
 */
export async function generateAndStoreThumbnail(
	env: Env,
	storageKey: string,
	mimeType: string | null | undefined,
): Promise<{ thumbnailKey: string; thumbnailUrl: string } | null> {
	if (!isThumbnailable(mimeType)) return null;
	if (!env.IMAGES) return null; // Encoding requires the Images binding.

	const original = await env.MEDIA_BUCKET.get(storageKey);
	if (!original) return null;

	try {
		let thumbBody: ReadableStream<Uint8Array> | null;

		if (isVideoMime(mimeType)) {
			if (!env.MEDIA) return null; // Need Media Transformations for video frames.
			// 1) Extract a still poster frame from the video original.
			const frame = await env.MEDIA.input(original.body)
				.transform({ width: THUMBNAIL_WIDTH })
				.output({ mode: "frame", time: "0s", format: "jpg" })
				.response();
			if (!frame.ok || !frame.body) return null;
			// 2) Re-encode the frame into a hyper-optimized AVIF.
			const thumb = await env.IMAGES.input(frame.body)
				.transform({ width: THUMBNAIL_WIDTH })
				.output({
					format: THUMBNAIL_FORMAT,
					quality: THUMBNAIL_QUALITY,
					anim: false,
				});
			thumbBody = thumb.response().body;
		} else {
			// Images binding caps input size; skip oversized originals gracefully.
			if (original.size > IMAGES_MAX_INPUT_BYTES) return null;
			const thumb = await env.IMAGES.input(original.body)
				.transform({ width: THUMBNAIL_WIDTH })
				// anim:false flattens animated GIF/WebP to a single still frame.
				.output({
					format: THUMBNAIL_FORMAT,
					quality: THUMBNAIL_QUALITY,
					anim: false,
				});
			thumbBody = thumb.response().body;
		}

		if (!thumbBody) return null;

		const thumbnailKey = thumbnailKeyFor(storageKey);
		await env.THUMBNAIL_BUCKET.put(thumbnailKey, thumbBody, {
			httpMetadata: { contentType: THUMBNAIL_FORMAT },
		});

		return { thumbnailKey, thumbnailUrl: thumbnailUrlFor(storageKey) };
	} catch (err) {
		console.error(`[Thumbnail] Generation failed for ${storageKey}:`, err);
		return null;
	}
}
