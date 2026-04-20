export interface UploadedMedia {
	url: string;
	type: string;
	filename: string;
	size: number;
}

export async function uploadMedia(file: File): Promise<UploadedMedia> {
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
			return { url, type: file.type, filename: file.name, size: file.size };
		}
	}

	// Fallback: direct upload through app proxy
	const res = await fetch(
		`/api/media/upload?filename=${encodeURIComponent(file.name)}`,
		{ method: "POST", headers: { "Content-Type": file.type }, body: file },
	);
	if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
	const { url } = (await res.json()) as { url: string };
	return { url, type: file.type, filename: file.name, size: file.size };
}
