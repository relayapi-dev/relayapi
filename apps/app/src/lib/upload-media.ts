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

export async function uploadMedia(
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
