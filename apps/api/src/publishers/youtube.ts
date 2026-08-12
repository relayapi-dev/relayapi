import {
	createBoundedReadableBody,
	ensureResponseContentLength,
	fetchPublicUrl,
	parseContentLength,
	readResponseBytes,
} from "../lib/fetch-public-url";
import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	getSucceededProviderEffect,
	mergeProviderEffects,
	type ProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
	recordProviderEffect,
} from "./types";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
// Official docs: https://developers.google.com/youtube/v3/docs/videos/insert
// Section "Media upload" -> maximum file size is 256 GB.
// The page does not state a binary GiB interpretation, so use the conservative
// decimal byte ceiling and avoid accepting files in the undocumented gap.
const YOUTUBE_VIDEO_MAX_BYTES = 256_000_000_000;
const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Truncate a string to fit within a byte limit (UTF-8). */
function truncateToBytes(str: string, maxBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(str).byteLength <= maxBytes) return str;
	// Binary search for the right cut point
	let low = 0;
	let high = str.length;
	while (low < high) {
		const mid = (low + high + 1) >>> 1;
		if (encoder.encode(str.slice(0, mid)).byteLength <= maxBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return str.slice(0, low);
}

interface YouTubeAuth {
	access_token: string;
}

interface YouTubeUploadBody {
	body: ReadableStream<Uint8Array>;
	contentLength: number;
	completion: Promise<number>;
}

/**
 * Interpret YouTube's zero-based resumable-upload Range header as the next byte
 * offset. A malformed or non-contiguous range must never be guessed.
 */
export function parseYouTubeUploadOffset(
	rangeHeader: string | null,
	totalBytes: number,
): number {
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
		throw new RangeError("YouTube upload size must be a positive safe integer");
	}
	if (rangeHeader === null) return 0;

	const match = /^bytes=0-(\d+)$/.exec(rangeHeader.trim());
	if (!match?.[1]) {
		throw new Error("YouTube returned an invalid resumable upload range");
	}
	const lastByte = Number(match[1]);
	if (
		!Number.isSafeInteger(lastByte) ||
		lastByte < 0 ||
		lastByte >= totalBytes
	) {
		throw new Error("YouTube returned an out-of-bounds resumable upload range");
	}
	return lastByte + 1;
}

export function getYouTubeUploadRangeHeader(
	totalBytes: number,
	offset: number,
	isResumeRequest: boolean,
): string | undefined {
	if (!isResumeRequest) return undefined;
	if (
		!Number.isSafeInteger(totalBytes) ||
		totalBytes <= 0 ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset >= totalBytes
	) {
		throw new RangeError("YouTube upload range is outside the video body");
	}
	return `bytes ${offset}-${totalBytes - 1}/${totalBytes}`;
}

/**
 * Re-read a stable source from byte zero while discarding the prefix already
 * committed by YouTube. This retains O(1) memory and emits a fixed-length body
 * for only the remaining suffix.
 */
export function createYouTubeUploadBody(
	response: Response,
	totalBytes: number,
	offset: number,
): YouTubeUploadBody {
	const declaredBytes = parseContentLength(response.headers);
	if (declaredBytes !== totalBytes) {
		void response.body?.cancel().catch(() => {});
		throw new Error("CONTENT_ERROR: Video size changed while resuming upload");
	}
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalBytes) {
		void response.body?.cancel().catch(() => {});
		throw new RangeError("YouTube resume offset is outside the video body");
	}

	const bounded = createBoundedReadableBody(
		response.body,
		totalBytes,
		totalBytes,
	);
	const reader = bounded.body.getReader();
	let skipped = 0;
	const suffix = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						if (skipped !== offset) {
							controller.error(
								new Error(
									"CONTENT_ERROR: Video ended before the resume offset",
								),
							);
							return;
						}
						controller.close();
						return;
					}

					if (skipped < offset) {
						const discard = Math.min(offset - skipped, value.byteLength);
						skipped += discard;
						if (discard === value.byteLength) continue;
						controller.enqueue(value.subarray(discard));
						return;
					}

					controller.enqueue(value);
					return;
				}
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
		},
	});

	const contentLength = totalBytes - offset;
	let body = suffix;
	let pipeCompletion: Promise<void> = Promise.resolve();
	if (typeof FixedLengthStream !== "undefined") {
		const fixed = new FixedLengthStream(contentLength);
		pipeCompletion = suffix.pipeTo(fixed.writable);
		void pipeCompletion.catch(() => {});
		body = fixed.readable;
	}

	const completion = Promise.all([pipeCompletion, bounded.bytesRead]).then(
		([, bytesRead]) => {
			if (bytesRead !== totalBytes) {
				throw new Error(
					`CONTENT_ERROR: Video source ended at ${bytesRead} of ${totalBytes} bytes`,
				);
			}
			return bytesRead;
		},
	);
	void completion.catch(() => {});
	return { body, contentLength, completion };
}

/**
 * Fetch media bytes from a URL.
 */
async function fetchMediaBytes(
	url: string,
	maxBytes: number,
): Promise<{ bytes: ArrayBuffer; contentType: string; size: number }> {
	const res = await fetchPublicUrl(url, { timeout: 30_000, maxBytes });
	if (!res.ok) {
		throw new PublishError(
			`Failed to fetch media from ${url}: ${res.statusText}`,
			{
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			},
		);
	}
	const bytes = await readResponseBytes(res, maxBytes);
	const contentType =
		res.headers.get("content-type") ?? "application/octet-stream";
	return { bytes, contentType, size: bytes.byteLength };
}

/**
 * Upload a video to YouTube using resumable upload.
 * 1. POST metadata to get a resumable upload URI
 * 2. PUT video bytes to the upload URI
 * 3. Return the video ID
 */
async function uploadVideo(
	auth: YouTubeAuth,
	videoUrl: string,
	metadata: {
		title: string;
		description: string;
		tags?: string[];
		categoryId: string;
		privacyStatus: string;
		madeForKids: boolean;
		containsSyntheticMedia?: boolean;
		publishAt?: string;
		notifySubscribers?: boolean;
	},
): Promise<string> {
	let mediaResponse = await fetchPublicUrl(videoUrl, { timeout: 30_000 });
	if (!mediaResponse.ok) {
		throw new PublishError(
			`Failed to fetch media from ${videoUrl}: ${mediaResponse.statusText}`,
			{
				statusCode: mediaResponse.status,
				detail: `HTTP ${mediaResponse.status} ${mediaResponse.statusText}`,
			},
		);
	}
	mediaResponse = await ensureResponseContentLength(
		mediaResponse,
		YOUTUBE_VIDEO_MAX_BYTES,
		() =>
			fetchPublicUrl(videoUrl, {
				timeout: 30_000,
				maxBytes: YOUTUBE_VIDEO_MAX_BYTES,
			}),
	);
	const size = parseContentLength(mediaResponse.headers) as number;
	const contentType =
		mediaResponse.headers.get("content-type") ?? "application/octet-stream";
	const rawSourceEtag = mediaResponse.headers.get("etag");
	const sourceEtag =
		rawSourceEtag && !rawSourceEtag.startsWith("W/") ? rawSourceEtag : null;

	// Build the metadata body
	const sanitizedTitle = metadata.title
		.replace(/[<>]/g, "")
		.trim()
		.slice(0, 100);
	if (!sanitizedTitle) {
		void mediaResponse.body?.cancel().catch(() => {});
		throw new Error(
			"CONTENT_ERROR: YouTube requires a non-empty title after removing unsupported characters.",
		);
	}
	const snippet: Record<string, unknown> = {
		// YouTube rejects titles containing < and > characters
		title: sanitizedTitle,
		// YouTube limits description to 5,000 bytes (not characters)
		// Docs: https://developers.google.com/youtube/v3/docs/videos#resource
		description: truncateToBytes(
			metadata.description.replace(/[<>]/g, ""),
			5000,
		),
		categoryId: metadata.categoryId,
	};

	if (metadata.tags && metadata.tags.length > 0) {
		// Official docs: https://developers.google.com/youtube/v3/docs/videos
		// Field `snippet.tags[]`: total length is 500 characters; commas count,
		// and a tag containing spaces is counted as if wrapped in quotation marks.
		const truncated: string[] = [];
		let charCount = 0;
		for (const tag of metadata.tags) {
			const quotedLength = tag.length + (/\s/.test(tag) ? 2 : 0);
			const added = quotedLength + (charCount === 0 ? 0 : 1);
			if (charCount + added > 500) break;
			truncated.push(tag);
			charCount += added;
		}
		if (truncated.length > 0) {
			snippet.tags = truncated;
		}
	}

	const status: Record<string, unknown> = {
		privacyStatus: metadata.privacyStatus,
		selfDeclaredMadeForKids: metadata.madeForKids,
	};

	if (metadata.containsSyntheticMedia !== undefined) {
		status.containsSyntheticMedia = metadata.containsSyntheticMedia;
	}

	if (metadata.publishAt) {
		status.publishAt = metadata.publishAt;
	}

	const requestBody = { snippet, status };

	// Step 1: Initiate resumable upload — send metadata and get upload URI
	// YouTube Data API — Resumable video upload (initiate)
	// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
	const notify = metadata.notifySubscribers ?? true;
	const initRes = await fetch(
		`${YOUTUBE_UPLOAD_API}/videos?uploadType=resumable&part=id,snippet,status&notifySubscribers=${notify}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/json; charset=UTF-8",
				"X-Upload-Content-Length": size.toString(),
				"X-Upload-Content-Type": contentType,
			},
			body: JSON.stringify(requestBody),
		},
	);

	if (!initRes.ok) {
		void mediaResponse.body?.cancel().catch(() => {});
		const err = await readPublisherJson(initRes).catch(() => ({}));
		const errBody = JSON.stringify(err);
		const raw = `HTTP ${initRes.status}\n${errBody}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			initRes.statusText;
		if (
			initRes.status === 401 ||
			errBody.includes("Unauthorized") ||
			errBody.includes("UNAUTHENTICATED") ||
			errBody.includes("invalid_grant")
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: initRes.status,
				detail: raw,
			});
		}
		if (errBody.includes("uploadLimitExceeded")) {
			throw new PublishError(`RATE_LIMITED: Daily upload limit reached`, {
				statusCode: initRes.status,
				detail: raw,
			});
		}
		throw new PublishError(`YouTube upload initialization failed: ${detail}`, {
			statusCode: initRes.status,
			detail: raw,
		});
	}

	const uploadUri = initRes.headers.get("location");
	if (!uploadUri) {
		void mediaResponse.body?.cancel().catch(() => {});
		throw new Error(
			"YouTube upload initialization did not return an upload URI",
		);
	}

	// Step 2: Upload the video bytes. After an interrupted request or a documented
	// resumable 5xx, query the session before sending only the uncommitted suffix.
	// Never replay the whole body to an existing session based on an assumption.
	// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
	let uploadData: { id?: string } | undefined;
	const maxRetries = 3;
	const resumableStatuses = new Set([500, 502, 503, 504]);
	let resumeOffset = 0;
	let resumeOffsetKnown = true;
	let isResumeRequest = false;
	let requestedRetryDelayMs = 0;
	const retryAfterMs = (response: Response): number => {
		const raw = response.headers.get("retry-after");
		if (!raw) return 0;
		const seconds = Number.parseFloat(raw);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
	};
	const throwUploadFailure = async (response: Response): Promise<never> => {
		const err = await readPublisherJson(response).catch(() => ({}));
		const raw = `HTTP ${response.status}\n${JSON.stringify(err)}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			response.statusText;
		throw new PublishError(`YouTube video upload failed: ${detail}`, {
			statusCode: response.status,
			detail: raw,
		});
	};
	const refetchStableVideo = async (): Promise<Response> => {
		if (resumeOffset > 0 && !sourceEtag) {
			throw new PublishError(
				"Cannot safely resume the partially accepted YouTube upload because the media source has no strong ETag",
				{ code: "PUBLISH_OUTCOME_UNKNOWN" },
			);
		}
		let replay = await fetchPublicUrl(videoUrl, {
			timeout: 30_000,
			maxBytes: YOUTUBE_VIDEO_MAX_BYTES,
			...(sourceEtag ? { headers: { "If-Match": sourceEtag } } : {}),
		});
		if (!replay.ok) {
			if (resumeOffset > 0) {
				throw new PublishError(
					`Unable to verify the source while resuming a partially accepted YouTube upload: HTTP ${replay.status}`,
					{
						code: "PUBLISH_OUTCOME_UNKNOWN",
						statusCode: replay.status,
						detail: `HTTP ${replay.status} ${replay.statusText}`,
					},
				);
			}
			throw new PublishError(
				`Failed to re-fetch media from ${videoUrl}: ${replay.statusText}`,
				{
					statusCode: replay.status,
					detail: `HTTP ${replay.status} ${replay.statusText}`,
				},
			);
		}
		replay = await ensureResponseContentLength(
			replay,
			YOUTUBE_VIDEO_MAX_BYTES,
			() =>
				fetchPublicUrl(videoUrl, {
					timeout: 30_000,
					maxBytes: YOUTUBE_VIDEO_MAX_BYTES,
					...(sourceEtag ? { headers: { "If-Match": sourceEtag } } : {}),
				}),
		);
		const replayRawEtag = replay.headers.get("etag");
		const replayEtag =
			replayRawEtag && !replayRawEtag.startsWith("W/") ? replayRawEtag : null;
		if (
			parseContentLength(replay.headers) !== size ||
			(sourceEtag !== null && replayEtag !== sourceEtag)
		) {
			void replay.body?.cancel().catch(() => {});
			throw new PublishError(
				"Media source changed while resuming a partially accepted YouTube upload",
				{
					code: resumeOffset > 0 ? "PUBLISH_OUTCOME_UNKNOWN" : "CONTENT_ERROR",
				},
			);
		}
		return replay;
	};

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = Math.max(
				Math.min(1000 * 2 ** (attempt - 1), 16000),
				requestedRetryDelayMs,
			);
			await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
			requestedRetryDelayMs = 0;

			if (!resumeOffsetKnown) {
				let statusResponse: Response;
				try {
					statusResponse = await fetch(uploadUri, {
						method: "PUT",
						headers: {
							Authorization: `Bearer ${auth.access_token}`,
							"Content-Length": "0",
							"Content-Range": `bytes */${size}`,
						},
					});
				} catch (error) {
					if (attempt < maxRetries) continue;
					throw error;
				}

				if (statusResponse.ok) {
					uploadData = (await readPublisherJson(statusResponse)) as {
						id: string;
					};
					break;
				}
				if (statusResponse.status === 308) {
					resumeOffset = parseYouTubeUploadOffset(
						statusResponse.headers.get("range"),
						size,
					);
					requestedRetryDelayMs = retryAfterMs(statusResponse);
					void statusResponse.body?.cancel().catch(() => {});
					resumeOffsetKnown = true;
					isResumeRequest = true;
				} else if (
					resumableStatuses.has(statusResponse.status) &&
					attempt < maxRetries
				) {
					requestedRetryDelayMs = retryAfterMs(statusResponse);
					void statusResponse.body?.cancel().catch(() => {});
					continue;
				} else {
					await throwUploadFailure(statusResponse);
				}
			}

			mediaResponse = await refetchStableVideo();
		}

		const source = createYouTubeUploadBody(mediaResponse, size, resumeOffset);
		const contentRange = getYouTubeUploadRangeHeader(
			size,
			resumeOffset,
			isResumeRequest,
		);
		const [uploadOutcome, completionOutcome] = await Promise.allSettled([
			fetch(uploadUri, {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${auth.access_token}`,
					"Content-Type": contentType,
					"Content-Length": source.contentLength.toString(),
					...(contentRange ? { "Content-Range": contentRange } : {}),
				},
				body: source.body,
			}),
			source.completion,
		]);
		if (uploadOutcome.status === "rejected") {
			if (attempt < maxRetries) {
				resumeOffsetKnown = false;
				isResumeRequest = false;
				continue;
			}
			throw completionOutcome.status === "rejected"
				? completionOutcome.reason
				: uploadOutcome.reason;
		}
		const uploadRes = uploadOutcome.value;

		if (uploadRes.ok) {
			if (completionOutcome.status === "rejected") {
				throw completionOutcome.reason;
			}
			uploadData = (await readPublisherJson(uploadRes)) as { id?: string };
			break;
		}

		if (uploadRes.status === 308 && attempt < maxRetries) {
			resumeOffset = parseYouTubeUploadOffset(
				uploadRes.headers.get("range"),
				size,
			);
			requestedRetryDelayMs = retryAfterMs(uploadRes);
			void uploadRes.body?.cancel().catch(() => {});
			resumeOffsetKnown = true;
			isResumeRequest = true;
			continue;
		}
		if (uploadRes.status === 308) {
			// Official docs: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
			// Section "Step 4.2: Process the API response" defines 308 as
			// "Resume Incomplete" and says Range may represent accepted bytes. Once
			// retries are exhausted the remote outcome is therefore not a rejection.
			void uploadRes.body?.cancel().catch(() => {});
			throw new PublishError(
				"YouTube resumable upload remained incomplete after all resume attempts; the remote outcome requires reconciliation.",
				{
					code: "PUBLISH_OUTCOME_UNKNOWN",
					statusCode: uploadRes.status,
					detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
				},
			);
		}

		if (resumableStatuses.has(uploadRes.status) && attempt < maxRetries) {
			requestedRetryDelayMs = retryAfterMs(uploadRes);
			void uploadRes.body?.cancel().catch(() => {});
			resumeOffsetKnown = false;
			isResumeRequest = false;
			continue;
		}

		await throwUploadFailure(uploadRes);
	}

	if (!uploadData) {
		throw new Error("YouTube video upload failed after retries");
	}
	const videoId = uploadData.id?.trim();
	if (!videoId) {
		throw new PublishError(
			"YouTube accepted the upload but did not return a video ID; the remote outcome requires reconciliation.",
			{ code: "PUBLISH_OUTCOME_UNKNOWN" },
		);
	}

	return videoId;
}

/**
 * Set a custom thumbnail for a YouTube video.
 */
async function setThumbnail(
	auth: YouTubeAuth,
	videoId: string,
	thumbnailUrl: string,
): Promise<void> {
	const { bytes, contentType } = await fetchMediaBytes(
		thumbnailUrl,
		YOUTUBE_THUMBNAIL_MAX_BYTES,
	);

	// YouTube Data API — Set video thumbnail (must use upload API base URL)
	// https://developers.google.com/youtube/v3/docs/thumbnails/set
	const res = await fetch(
		`${YOUTUBE_UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": contentType,
			},
			body: bytes,
		},
	);

	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new PublishError(`YouTube thumbnail upload failed: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}
}

/**
 * Post a first comment on a YouTube video.
 */
async function postFirstComment(
	auth: YouTubeAuth,
	videoId: string,
	channelId: string,
	commentText: string,
): Promise<string> {
	// YouTube Data API v3 — CommentThreads: insert
	// Docs: https://developers.google.com/youtube/v3/docs/commentThreads/insert
	// Section: "Request body" — snippet.channelId, snippet.videoId, snippet.topLevelComment.snippet.textOriginal
	// Returns: CommentThread resource with id and snippet.topLevelComment.id
	// Note: YouTube Data API v3 does not expose a comment-pinning endpoint.
	// Pinning is only available via YouTube Studio UI — not available in the API.
	const res = await fetch(`${YOUTUBE_API}/commentThreads?part=snippet`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			snippet: {
				channelId,
				videoId,
				topLevelComment: {
					snippet: {
						textOriginal: commentText,
					},
				},
			},
		}),
	});

	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new PublishError(`YouTube first comment failed: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	const data = (await readPublisherJson(res)) as {
		id: string;
		snippet?: { topLevelComment?: { id?: string } };
	};
	return data.snippet?.topLevelComment?.id ?? data.id;
}

/**
 * Add a video to a YouTube playlist.
 * YouTube Data API — PlaylistItems: insert
 * https://developers.google.com/youtube/v3/docs/playlistItems/insert
 * Quota cost: 50 units per call.
 */
export async function addToPlaylist(
	auth: YouTubeAuth,
	playlistId: string,
	videoId: string,
): Promise<string> {
	const res = await fetch(`${YOUTUBE_API}/playlistItems?part=snippet`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			snippet: {
				playlistId,
				resourceId: { kind: "youtube#video", videoId },
			},
		}),
	});
	if (!res.ok) {
		const text = await readPublisherText(res).catch(() => "");
		throw new PublishError(
			`Failed to add video ${videoId} to playlist ${playlistId}`,
			{ statusCode: res.status, detail: text },
		);
	}
	const data = (await readPublisherJson(res)) as { id?: string };
	if (!data.id) {
		throw new Error("YouTube playlist item response did not include an ID");
	}
	return data.id;
}

interface YouTubeVideoState {
	id?: string;
	processingDetails?: {
		processingStatus?: string;
		processingFailureReason?: string;
	};
	status?: {
		uploadStatus?: string;
		failureReason?: string;
		rejectionReason?: string;
		privacyStatus?: string;
		publishAt?: string;
	};
}

function youtubeVideoStateResult(
	video: YouTubeVideoState,
	effects: ProviderEffect[] = [],
): PublishResult {
	const videoId = video.id?.trim();
	if (!videoId) {
		return {
			success: false,
			provider_outcome: {
				disposition: "outcome_unknown",
				provider_state: "video_not_found",
				effects,
			},
			error: {
				code: "PUBLISH_OUTCOME_UNKNOWN",
				message:
					"YouTube did not return the uploaded video during reconciliation.",
			},
		};
	}
	const processing = video.processingDetails?.processingStatus?.toLowerCase();
	const upload = video.status?.uploadStatus?.toLowerCase();
	const providerState =
		[upload, processing].filter(Boolean).join(":") || "unknown";
	const shared = {
		provider_operation_id: videoId,
		platform_post_id: videoId,
		platform_url: `https://www.youtube.com/watch?v=${videoId}`,
		provider_state: providerState,
		effects,
	};
	if (
		processing === "failed" ||
		processing === "terminated" ||
		upload === "failed" ||
		upload === "rejected" ||
		upload === "deleted"
	) {
		const reason =
			video.processingDetails?.processingFailureReason ??
			video.status?.failureReason ??
			video.status?.rejectionReason ??
			providerState;
		return {
			success: false,
			platform_post_id: videoId,
			provider_outcome: { disposition: "failed", ...shared },
			error: {
				code: "CONTENT_ERROR",
				message: `YouTube processing failed: ${reason}`,
			},
		};
	}
	if (processing === "succeeded" || upload === "processed") {
		const publishAt = video.status?.publishAt;
		const scheduled =
			video.status?.privacyStatus === "private" &&
			Boolean(publishAt && Date.parse(publishAt) > Date.now());
		return {
			success: true,
			platform_post_id: videoId,
			platform_url: shared.platform_url,
			provider_outcome: scheduled
				? {
						disposition: "scheduled",
						...shared,
						next_reconcile_at: publishAt,
					}
				: { disposition: "published", ...shared },
		};
	}
	return {
		success: true,
		platform_post_id: videoId,
		platform_url: shared.platform_url,
		provider_outcome: { disposition: "processing", ...shared },
	};
}

export const youtubePublisher: Publisher = {
	platform: "youtube",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		try {
			const videoId =
				request.platform_post_id ??
				request.provider_operation_id ??
				request.effects.find(
					(effect) =>
						effect.name === "video_upload" && effect.status === "succeeded",
				)?.provider_id;
			if (!videoId) {
				throw new Error(
					"CONTENT_ERROR: YouTube reconciliation requires a video ID.",
				);
			}
			// Official docs: https://developers.google.com/youtube/v3/docs/videos/list
			// `part=processingDetails,status` returns the upload/processing lifecycle.
			const response = await fetch(
				`${YOUTUBE_API}/videos?part=processingDetails%2Cstatus&id=${encodeURIComponent(videoId)}`,
				{
					headers: { Authorization: `Bearer ${request.account.access_token}` },
				},
			);
			if (!response.ok) {
				const body = await readPublisherText(response);
				throw new PublishError(
					`YouTube status lookup failed (${response.status})`,
					{ statusCode: response.status, detail: body },
				);
			}
			const data = (await readPublisherJson(response)) as {
				items?: YouTubeVideoState[];
			};
			return youtubeVideoStateResult(data.items?.[0] ?? {}, request.effects);
		} catch (err) {
			return classifyPublishError(err);
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const auth: YouTubeAuth = {
				access_token: request.account.access_token,
			};
			const opts = request.target_options;

			// YouTube requires exactly one video
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const videoItems = media.filter((m) => m.type === "video");
			const videoItem = videoItems[0];

			if (!videoItem) {
				return {
					success: false,
					error: {
						code: "VIDEO_REQUIRED",
						message:
							"YouTube requires exactly one video per post. No video found in media.",
					},
				};
			}

			if (videoItems.length > 1) {
				// Official docs: https://developers.google.com/youtube/v3/docs/videos/insert
				// Method `videos.insert` uploads one video resource per request. Image
				// attachments may still supply a thumbnail.
				return {
					success: false,
					error: {
						code: "TOO_MANY_VIDEOS",
						message: "YouTube supports exactly one video per publish request.",
					},
				};
			}

			const unsupportedItems = media.filter(
				(item) => item.type !== "video" && item.type !== "image",
			);
			if (unsupportedItems.length > 0) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message:
							"YouTube accepts exactly one typed video and at most one typed image thumbnail; untyped, GIF, and document attachments are not accepted.",
					},
				};
			}

			const imageItems = media.filter((m) => m.type === "image");
			if (imageItems.length > 1) {
				// Official docs: https://developers.google.com/youtube/v3/docs/thumbnails/set
				// `thumbnails.set` uploads one custom thumbnail for one `videoId`.
				// Reject unused image attachments instead of silently dropping them.
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message:
							"YouTube supports at most one image attachment as the custom thumbnail.",
					},
				};
			}

			// Resolve content — target_options.content overrides request.content (used as description)
			const description = (opts.content as string) ?? request.content ?? "";

			// Resolve title — falls back to first line of content
			const requestedTitle = (opts.title as string | undefined)?.trim();
			const derivedTitle = description.split("\n")[0]?.trim().slice(0, 100);
			const title = requestedTitle || derivedTitle || "Untitled";

			// Resolve options
			const visibility = (opts.visibility as string) ?? "public";
			const madeForKids = (opts.made_for_kids as boolean) ?? false;
			const containsSyntheticMedia = opts.contains_synthetic_media as
				| boolean
				| undefined;
			const categoryId = (opts.category_id as string) ?? "22";
			const tags = opts.tags as string[] | undefined;
			const publishAt = opts.publish_at as string | undefined;
			const notifySubscribers = (opts.notify_subscribers as boolean) ?? true;

			// For scheduled posts, upload as private with publishAt
			const effectivePrivacy = publishAt ? "private" : visibility;

			let effects = mergeProviderEffects(request.effect_recorder?.effects);
			const recordEffect = async (effect: ProviderEffect): Promise<void> => {
				await recordProviderEffect(request, effect);
				effects = mergeProviderEffects(effects, [effect]);
			};

			// The uploaded video is already a provider-side resource. Journal its ID
			// before any optional follow-up mutation so a Worker stop can reconcile or
			// resume without uploading the same video again.
			const confirmedUpload = getSucceededProviderEffect(
				request,
				"video_upload",
			);
			const videoId =
				confirmedUpload?.provider_id ??
				(await uploadVideo(auth, videoItem.url, {
					title,
					description,
					tags,
					categoryId,
					privacyStatus: effectivePrivacy,
					madeForKids,
					containsSyntheticMedia,
					publishAt,
					notifySubscribers,
				}));
			if (!confirmedUpload) {
				await recordEffect({
					name: "video_upload",
					status: "succeeded",
					provider_id: videoId,
				});
			}

			// Set custom thumbnail if provided in media item
			const thumbnailItem = imageItems[0];
			if (thumbnailItem) {
				if (getSucceededProviderEffect(request, "thumbnail")) {
					// The exact operation already confirmed this follow-up.
				} else
					try {
						await setThumbnail(auth, videoId, thumbnailItem.url);
						await recordEffect({
							name: "thumbnail",
							status: "succeeded",
							provider_id: videoId,
						});
					} catch (error) {
						await recordEffect({
							name: "thumbnail",
							status: "failed",
							error: {
								code: "PLATFORM_ERROR",
								message:
									error instanceof Error
										? error.message
										: "Thumbnail upload failed",
							},
						});
					}
			}

			// Post first comment if requested
			const firstComment = opts.first_comment as string | undefined;
			if (firstComment) {
				if (getSucceededProviderEffect(request, "first_comment")) {
					// The exact operation already confirmed this follow-up.
				} else
					try {
						const commentId = await postFirstComment(
							auth,
							videoId,
							request.account.platform_account_id,
							firstComment,
						);
						await recordEffect({
							name: "first_comment",
							status: "succeeded",
							provider_id: commentId,
						});
					} catch (error) {
						await recordEffect({
							name: "first_comment",
							status: "failed",
							error: {
								code: "PLATFORM_ERROR",
								message:
									error instanceof Error
										? error.message
										: "Comment creation failed",
							},
						});
					}
			}

			// Add to playlist if requested
			const playlistId =
				(opts.playlist_id as string | undefined) ??
				(request.account.metadata?.default_playlist_id as string | undefined);
			if (playlistId) {
				if (getSucceededProviderEffect(request, "playlist_item")) {
					// The exact operation already confirmed this follow-up.
				} else
					try {
						const playlistItemId = await addToPlaylist(
							auth,
							playlistId,
							videoId,
						);
						await recordEffect({
							name: "playlist_item",
							status: "succeeded",
							provider_id: playlistItemId,
						});
					} catch (error) {
						await recordEffect({
							name: "playlist_item",
							status: "failed",
							error: {
								code: "PLATFORM_ERROR",
								message:
									error instanceof Error
										? error.message
										: "Playlist insertion failed",
							},
						});
					}
			}

			const platformUrl = `https://www.youtube.com/watch?v=${videoId}`;

			return {
				success: true,
				platform_post_id: videoId,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "processing",
					provider_operation_id: videoId,
					platform_post_id: videoId,
					platform_url: platformUrl,
					provider_state: "uploaded:processing",
					effects,
				},
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
