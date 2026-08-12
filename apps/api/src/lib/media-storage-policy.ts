/**
 * Maximum canonical media object size accepted by RelayAPI. Large objects must
 * use a resumable upload session; the legacy proxy endpoint intentionally keeps
 * its smaller limit so it remains portable across Workers plans.
 */
export const MAX_MEDIA_UPLOAD_BYTES = 200 * 1024 * 1024;

export const MAX_DIRECT_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Multipart is used early enough to make retries inexpensive and resumable. */
export const MEDIA_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const MEDIA_MULTIPART_PART_BYTES = 16 * 1024 * 1024;

/** Stable profile name shared by automatic processing and publish selection. */
export const AUTOMATIC_MEDIA_PROFILE = "publish-standard-v1";

// Stored XSS and active-content defense. Keep this list deliberately narrow and
// shared by direct uploads, presigned confirmation, recovery, and read signing.
export const ALLOWED_MEDIA_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/avif",
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/mpeg",
	"audio/mpeg",
	"audio/mp4",
	"audio/webm",
	"audio/wav",
	"audio/ogg",
	"application/pdf",
]);

export function normalizeMediaMimeType(
	value: string | null | undefined,
): string {
	return (value?.split(";")[0] ?? "").trim().toLowerCase();
}

export function isAllowedMediaMimeType(
	value: string | null | undefined,
): boolean {
	return ALLOWED_MEDIA_MIME_TYPES.has(normalizeMediaMimeType(value));
}

export type StoredMediaValidation =
	| { ok: true; mimeType: string; size: number }
	| {
			ok: false;
			code: "INVALID_FILE_TYPE" | "FILE_TOO_LARGE";
			message: string;
	  };

type StoredMediaObject = Pick<R2Object, "httpMetadata" | "size">;

/**
 * Validate the metadata R2 actually persisted, never only the client's declared
 * upload intent. Missing Content-Type is rejected because it cannot be proven to
 * belong to the active-content allowlist.
 */
export function validateStoredMediaObject(
	object: StoredMediaObject,
): StoredMediaValidation {
	const rawContentType = object.httpMetadata?.contentType;
	const mimeType = normalizeMediaMimeType(rawContentType);
	if (!mimeType || !ALLOWED_MEDIA_MIME_TYPES.has(mimeType)) {
		return {
			ok: false,
			code: "INVALID_FILE_TYPE",
			message: rawContentType
				? `File type '${rawContentType}' is not allowed`
				: "Stored object is missing an allowed Content-Type",
		};
	}
	if (object.size > MAX_MEDIA_UPLOAD_BYTES) {
		return {
			ok: false,
			code: "FILE_TOO_LARGE",
			message: `File size ${object.size} exceeds maximum of ${MAX_MEDIA_UPLOAD_BYTES / 1024 / 1024}MB`,
		};
	}
	return { ok: true, mimeType, size: object.size };
}
