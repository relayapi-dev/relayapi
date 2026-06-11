export interface UploadedMedia {
	url: string;
	type: string;
	filename: string;
	size: number;
}

export async function uploadMedia(file: File): Promise<UploadedMedia> {
	try {
		const presignRes = await fetch("/api/media/presign", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: file.name, content_type: file.type }),
		});

		if (presignRes.ok) {
			const { upload_url, url } = (await presignRes.json()) as {
				upload_url: string;
				url: string;
			};
			const put = await fetch(upload_url, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
			});
			if (put.ok) {
				// Confirm the upload so the media row flips pending -> ready
				// (otherwise it stays size=0 and never appears in the library,
				// and confirm-time MIME/size re-verification never runs).
				// The storage key is the URL path after the host, taken from the
				// raw string (not URL.pathname) to avoid percent-encoding the key,
				// since the API stores and looks it up in its un-encoded form.
				const parsed = new URL(url);
				const storageKey = url
					.slice(parsed.origin.length)
					.replace(/^\/+/, "");
				const confirmRes = await fetch("/api/media/confirm", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ storage_key: storageKey }),
				});
				if (confirmRes.ok) {
					return { url, type: file.type, filename: file.name, size: file.size };
				}
				// Confirm failed (e.g. rejected MIME/size) — fall through to the
				// direct upload proxy rather than returning an unconfirmed URL.
			}
		}
	} catch {
		// Presign flow is best-effort; fall back to the direct upload proxy.
	}

	// Fallback: direct upload through app proxy
	const res = await fetch(
		`/api/media/upload?filename=${encodeURIComponent(file.name)}`,
		{ method: "POST", headers: { "Content-Type": file.type }, body: file },
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as
			| { error?: { message?: string } }
			| { message?: string }
			| null;
		const message = err && typeof err === "object"
			? ("error" in err ? err.error?.message : undefined) ?? ("message" in err ? err.message : undefined)
			: undefined;
		throw new Error(
			message ?? `Upload failed: ${res.status}`,
		);
	}
	const { url } = (await res.json()) as { url: string };
	return { url, type: file.type, filename: file.name, size: file.size };
}
