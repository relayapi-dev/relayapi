export type MediaDerivativeKind =
	| "normalized"
	| "provider"
	| "cover"
	| "gif_video";

function extensionFor(mimeType: string): string {
	switch (mimeType) {
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/webp":
			return "webp";
		case "video/mp4":
			return "mp4";
		case "audio/mp4":
			return "m4a";
		default:
			throw new Error(`Unsupported processor output MIME type ${mimeType}`);
	}
}

/**
 * Every processing generation receives an immutable object key. PostgreSQL's
 * lease-token CAS decides which generation may project that key, while stale
 * workflows can only leave an isolated object that cleanup/lifecycle may reap.
 */
export function mediaDerivativeStorageKey(input: {
	organizationId: string;
	mediaId: string;
	jobId: string;
	generation: number;
	kind: MediaDerivativeKind;
	mimeType: string;
}): string {
	if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
		throw new Error("Media processing generation must be a positive integer");
	}
	return `${input.organizationId}/media-derivatives/${input.mediaId}/${input.jobId}/generation-${input.generation}/${input.kind}.${extensionFor(input.mimeType)}`;
}
