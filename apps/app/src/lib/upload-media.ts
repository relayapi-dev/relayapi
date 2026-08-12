export interface UploadedMedia {
	/**
	 * The durable `med_` reference. Absent only on the proxy-upload fallback
	 * against an API build that predates the id being returned — the app and API
	 * Workers deploy independently, so that skew is reachable in production.
	 * Callers that need a durable handle should fall back to `url`, which the
	 * API resolves back to the same row by storage key.
	 */
	id?: string;
	url: string;
	type: string;
	filename: string;
	size: number;
}

export interface UploadMediaOptions {
	workspaceId?: string | null;
}

const MAX_MEDIA_UPLOAD_BYTES = 200 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
const PART_URL_BATCH_SIZE = 32;
const PART_UPLOAD_CONCURRENCY = 4;

interface MediaProjection {
	id: string;
	filename: string;
	mime_type: string;
	size: number;
	url: string | null;
	reference_url: string | null;
}

interface UploadSession {
	id: string;
	media_id: string;
	mode: "single" | "multipart";
	status: string;
	part_size: number | null;
	part_count: number | null;
	upload?: { url: string; headers: Record<string, string> } | null;
	media?: MediaProjection | null;
}

class UploadRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "UploadRequestError";
	}
}

async function responseErrorMessage(
	response: Response,
	fallback: string,
): Promise<string> {
	const body = (await response.json().catch(() => null)) as
		| { error?: { message?: string } }
		| { message?: string }
		| null;
	if (body && typeof body === "object") {
		const message =
			("error" in body ? body.error?.message : undefined) ??
			("message" in body ? body.message : undefined);
		if (message) return message;
	}
	return fallback;
}

async function requestUploadJson<T>(
	url: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new UploadRequestError(
			await responseErrorMessage(
				response,
				`Media upload request failed: ${response.status}`,
			),
			response.status,
		);
	}
	return (await response.json()) as T;
}

function uploadedMediaFromProjection(
	media: MediaProjection,
	file: File,
): UploadedMedia {
	const url = media.reference_url ?? media.url;
	if (!url) {
		throw new Error("Upload completed without a stable media URL.");
	}
	return {
		id: media.id,
		url,
		type: media.mime_type || file.type,
		filename: media.filename || file.name,
		size: media.size,
	};
}

async function retrieveCompletedUpload(
	sessionId: string,
	file: File,
): Promise<UploadedMedia | null> {
	try {
		const session = await requestUploadJson<UploadSession>(
			`/api/media/uploads/${encodeURIComponent(sessionId)}`,
		);
		return session.status === "completed" && session.media
			? uploadedMediaFromProjection(session.media, file)
			: null;
	} catch {
		return null;
	}
}

async function abandonUploadSession(
	sessionId: string,
	originalError: unknown,
): Promise<never> {
	let response: Response;
	try {
		response = await fetch(
			`/api/media/uploads/${encodeURIComponent(sessionId)}`,
			{ method: "DELETE" },
		);
	} catch {
		throw new Error(
			"Upload failed and its resumable session could not be cleaned up. Check the media library before retrying.",
		);
	}
	if (response.status === 409) {
		throw new Error(
			"Upload completion could not be confirmed. Check the media library before retrying to avoid a duplicate upload.",
		);
	}
	if (!response.ok && response.status !== 404) {
		throw new Error(
			"Upload failed and its resumable session could not be cleaned up. Check the media library before retrying.",
		);
	}
	throw originalError;
}

async function completeUploadSession(
	sessionId: string,
	parts: Array<{ part_number: number; etag: string }>,
	file: File,
): Promise<UploadedMedia> {
	const complete = () =>
		requestUploadJson<MediaProjection>(
			`/api/media/uploads/${encodeURIComponent(sessionId)}/complete`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parts }),
			},
		);
	try {
		return uploadedMediaFromProjection(await complete(), file);
	} catch (error) {
		if (error instanceof UploadRequestError && error.status < 500) throw error;
		const recovered = await retrieveCompletedUpload(sessionId, file);
		if (recovered) return recovered;
		try {
			return uploadedMediaFromProjection(await complete(), file);
		} catch (retryError) {
			const retryRecovered = await retrieveCompletedUpload(sessionId, file);
			if (retryRecovered) return retryRecovered;
			throw retryError;
		}
	}
}

async function uploadWithSession(
	file: File,
	options: UploadMediaOptions,
): Promise<UploadedMedia> {
	const session = await requestUploadJson<UploadSession>("/api/media/uploads", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			filename: file.name,
			content_type: file.type,
			size_bytes: file.size,
			workspace_id: options.workspaceId ?? undefined,
		}),
	});

	try {
		if (session.mode === "single") {
			if (!session.upload?.url) {
				throw new Error("Upload session did not include a direct upload URL.");
			}
			const response = await fetch(session.upload.url, {
				method: "PUT",
				headers: session.upload.headers,
				body: file,
			});
			if (!response.ok) {
				throw new Error(`Direct storage upload failed: ${response.status}`);
			}
			return await completeUploadSession(session.id, [], file);
		}

		if (!session.part_size || !session.part_count) {
			throw new Error("Multipart upload session is missing its part plan.");
		}
		const partSize = session.part_size;
		const partCount = session.part_count;
		const completedParts: Array<{ part_number: number; etag: string }> = [];
		for (
			let batchStart = 1;
			batchStart <= partCount;
			batchStart += PART_URL_BATCH_SIZE
		) {
			const partNumbers = Array.from(
				{
					length: Math.min(PART_URL_BATCH_SIZE, partCount - batchStart + 1),
				},
				(_, index) => batchStart + index,
			);
			const signed = await requestUploadJson<{
				parts: Array<{
					part_number: number;
					upload_url: string;
					upload_headers: Record<string, string>;
				}>;
			}>(`/api/media/uploads/${encodeURIComponent(session.id)}/parts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ part_numbers: partNumbers }),
			});
			if (signed.parts.length !== partNumbers.length) {
				throw new Error(
					"Storage did not return every requested multipart URL.",
				);
			}

			for (
				let offset = 0;
				offset < signed.parts.length;
				offset += PART_UPLOAD_CONCURRENCY
			) {
				const batch = signed.parts.slice(
					offset,
					offset + PART_UPLOAD_CONCURRENCY,
				);
				const uploaded = await Promise.all(
					batch.map(async (part) => {
						const start = (part.part_number - 1) * partSize;
						const end = Math.min(start + partSize, file.size);
						const response = await fetch(part.upload_url, {
							method: "PUT",
							headers: part.upload_headers,
							body: file.slice(start, end),
						});
						if (!response.ok) {
							throw new Error(
								`Multipart upload part ${part.part_number} failed: ${response.status}`,
							);
						}
						const etag = response.headers.get("etag")?.trim();
						if (!etag) {
							throw new Error(
								"Multipart upload response did not expose ETag. Verify the media bucket CORS policy before retrying.",
							);
						}
						return { part_number: part.part_number, etag };
					}),
				);
				completedParts.push(...uploaded);
			}
		}
		completedParts.sort((left, right) => left.part_number - right.part_number);
		return await completeUploadSession(session.id, completedParts, file);
	} catch (error) {
		const recovered = await retrieveCompletedUpload(session.id, file);
		if (recovered) return recovered;
		return abandonUploadSession(session.id, error);
	}
}

async function abandonPresignedUpload(mediaId: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`/api/media/${encodeURIComponent(mediaId)}`, {
			method: "DELETE",
		});
	} catch {
		throw new Error(
			"The presigned upload failed and its pending record could not be cleaned up. Please try again.",
		);
	}
	if (!response.ok && response.status !== 404) {
		throw new Error(
			"The presigned upload failed and its pending record could not be cleaned up. Please try again.",
		);
	}
}

async function uploadMediaLegacy(
	file: File,
	options: UploadMediaOptions = {},
): Promise<UploadedMedia> {
	let uploadedUrl: string | null = null;
	let presignedIntent:
		| {
				id: string;
				uploadUrl: string;
				publicUrl: string;
				uploadHeaders: {
					"Content-Type": string;
					"If-None-Match": "*";
				};
		  }
		| undefined;

	try {
		const presignRes = await fetch("/api/media/presign", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				filename: file.name,
				content_type: file.type,
				workspace_id: options.workspaceId ?? undefined,
			}),
		});

		if (presignRes.ok) {
			const { id, upload_url, upload_headers, url } =
				(await presignRes.json()) as {
					id: string;
					upload_url: string;
					upload_headers?: {
						"Content-Type": string;
						"If-None-Match": "*";
					};
					url: string;
				};
			if (id && upload_url && url) {
				presignedIntent = {
					id,
					uploadUrl: upload_url,
					publicUrl: url,
					uploadHeaders: {
						"Content-Type": upload_headers?.["Content-Type"] || file.type,
						"If-None-Match": "*",
					},
				};
			}
		}
	} catch {
		// The API did not return an actionable intent. Its stale-intent reconciler
		// is the final safety net if a response was interrupted after persistence.
	}

	if (presignedIntent) {
		let putSucceeded = false;
		try {
			const put = await fetch(presignedIntent.uploadUrl, {
				method: "PUT",
				headers: presignedIntent.uploadHeaders,
				body: file,
			});
			putSucceeded = put.ok;
		} catch {
			// A transport failure is ambiguous. Deleting the durable intent removes
			// any bytes that may have arrived before a direct fallback can run.
		}

		if (putSucceeded) {
			uploadedUrl = presignedIntent.publicUrl;
		} else {
			await abandonPresignedUpload(presignedIntent.id);
		}
	}

	if (uploadedUrl !== null) {
		const confirmedIntent = presignedIntent;
		if (!confirmedIntent) {
			throw new Error("Presigned upload intent was lost before confirmation.");
		}
		let confirmRes: Response;
		try {
			// Confirm the upload so the media row flips pending -> ready. The
			// storage key comes from the raw URL string to preserve its encoding.
			const parsed = new URL(uploadedUrl);
			const storageKey = uploadedUrl
				.slice(parsed.origin.length)
				.replace(/^\/+/, "");
			confirmRes = await fetch("/api/media/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ storage_key: storageKey }),
			});
		} catch {
			// The confirm request may have committed before its response was lost.
			// Fail closed by deleting the intent either way; DELETE is idempotent and
			// safely retires an already-ready row before the user retries the upload.
			await abandonPresignedUpload(confirmedIntent.id);
			throw new Error(
				"Upload succeeded, but confirmation could not be completed. Please try again.",
			);
		}

		if (!confirmRes.ok) {
			const err = (await confirmRes.json().catch(() => null)) as
				| { error?: { message?: string } }
				| { message?: string }
				| null;
			const message =
				err && typeof err === "object"
					? (("error" in err ? err.error?.message : undefined) ??
						("message" in err ? err.message : undefined))
					: undefined;
			await abandonPresignedUpload(confirmedIntent.id);
			throw new Error(
				message ?? `Upload confirmation failed: ${confirmRes.status}`,
			);
		}

		return {
			id: confirmedIntent.id,
			url: uploadedUrl,
			type: file.type,
			filename: file.name,
			size: file.size,
		};
	}

	// Fallback: direct upload through app proxy
	const params = new URLSearchParams({ filename: file.name });
	if (options.workspaceId) params.set("workspace_id", options.workspaceId);
	const res = await fetch(`/api/media/upload?${params.toString()}`, {
		method: "POST",
		headers: { "Content-Type": file.type },
		body: file,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as
			| { error?: { message?: string } }
			| { message?: string }
			| null;
		const message =
			err && typeof err === "object"
				? (("error" in err ? err.error?.message : undefined) ??
					("message" in err ? err.message : undefined))
				: undefined;
		throw new Error(message ?? `Upload failed: ${res.status}`);
	}
	const { id, url } = (await res.json()) as { id?: string; url?: string };
	// The bytes are already stored at this point, so a missing id must not be
	// reported as a failed upload — that would surface an error for a successful
	// upload and orphan the object. Only a missing url leaves nothing usable.
	if (!url) {
		throw new Error("Upload completed without a media URL.");
	}
	return {
		...(id ? { id } : {}),
		url,
		type: file.type,
		filename: file.name,
		size: file.size,
	};
}

export async function uploadMedia(
	file: File,
	options: UploadMediaOptions = {},
): Promise<UploadedMedia> {
	if (file.size <= 0) throw new Error("Media files cannot be empty.");
	if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
		throw new Error("Media files cannot exceed 200 MiB.");
	}
	return file.size > MULTIPART_THRESHOLD_BYTES
		? uploadWithSession(file, options)
		: uploadMediaLegacy(file, options);
}
