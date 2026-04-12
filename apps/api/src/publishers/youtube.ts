import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";

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

/**
 * Fetch media bytes from a URL.
 */
async function fetchMediaBytes(
	url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string; size: number }> {
	const res = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!res.ok) {
		throw new Error(`Failed to fetch media from ${url}: ${res.statusText}`);
	}
	const bytes = await res.arrayBuffer();
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
	const { bytes, contentType, size } = await fetchMediaBytes(videoUrl);

	// Workers have ~128-256MB memory — reject excessively large files early
	if (size > 200 * 1024 * 1024) {
		throw new Error(
			`CONTENT_ERROR: Video is ${(size / 1024 / 1024).toFixed(0)}MB. Maximum supported size for direct upload is 200MB.`,
		);
	}

	// Build the metadata body
	const snippet: Record<string, unknown> = {
		// YouTube rejects titles containing < and > characters
		title: metadata.title.replace(/[<>]/g, "").slice(0, 100),
		// YouTube limits description to 5,000 bytes (not characters)
		// Docs: https://developers.google.com/youtube/v3/docs/videos#resource
		description: truncateToBytes(metadata.description.replace(/[<>]/g, ""), 5000),
		categoryId: metadata.categoryId,
	};

	if (metadata.tags && metadata.tags.length > 0) {
		// YouTube limits total tag characters (joined by commas) to 500
		const truncated: string[] = [];
		let charCount = 0;
		for (const tag of metadata.tags) {
			const added = charCount === 0 ? tag.length : tag.length + 1; // +1 for comma separator
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
		const err = await initRes.json().catch(() => ({}));
		const errBody = JSON.stringify(err);
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			initRes.statusText;
		if (initRes.status === 401 || errBody.includes("Unauthorized") || errBody.includes("UNAUTHENTICATED") || errBody.includes("invalid_grant")) {
			throw new Error(`TOKEN_EXPIRED: ${detail}`);
		}
		if (errBody.includes("uploadLimitExceeded")) {
			throw new Error(`RATE_LIMITED: Daily upload limit reached`);
		}
		throw new Error(`YouTube upload initialization failed: ${detail}`);
	}

	const uploadUri = initRes.headers.get("location");
	if (!uploadUri) {
		throw new Error(
			"YouTube upload initialization did not return an upload URI",
		);
	}

	// Step 2: Upload the video bytes with retry for 5xx errors
	// YouTube recommends exponential backoff for 500, 502, 503, 504 errors
	// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
	let uploadData: { id: string } | undefined;
	const maxRetries = 3;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = Math.min(1000 * 2 ** (attempt - 1), 16000);
			await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
		}

		const uploadRes = await fetch(uploadUri, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": contentType,
				"Content-Length": size.toString(),
			},
			body: bytes,
		});

		if (uploadRes.ok) {
			uploadData = (await uploadRes.json()) as { id: string };
			break;
		}

		// Retry on 5xx server errors
		if (uploadRes.status >= 500 && uploadRes.status < 600 && attempt < maxRetries) {
			continue;
		}

		const err = await uploadRes.json().catch(() => ({}));
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			uploadRes.statusText;
		throw new Error(`YouTube video upload failed: ${detail}`);
	}

	if (!uploadData) {
		throw new Error("YouTube video upload failed after retries");
	}

	return uploadData.id;
}

/**
 * Set a custom thumbnail for a YouTube video.
 */
async function setThumbnail(
	auth: YouTubeAuth,
	videoId: string,
	thumbnailUrl: string,
): Promise<void> {
	const { bytes, contentType } = await fetchMediaBytes(thumbnailUrl);

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
		const err = await res.json().catch(() => ({}));
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new Error(`YouTube thumbnail upload failed: ${detail}`);
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
		const err = await res.json().catch(() => ({}));
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new Error(`YouTube first comment failed: ${detail}`);
	}

	const data = (await res.json()) as {
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
): Promise<void> {
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
		const text = await res.text().catch(() => "");
		console.warn(
			`Failed to add video ${videoId} to playlist ${playlistId}: ${res.status} ${text}`,
		);
	}
}

export const youtubePublisher: Publisher = {
	platform: "youtube",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const auth: YouTubeAuth = {
				access_token: request.account.access_token,
			};
			const opts = request.target_options;

			// YouTube requires exactly one video
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const videoItem = media.find((m) => m.type === "video");

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

			// Resolve content — target_options.content overrides request.content (used as description)
			const description = (opts.content as string) ?? request.content ?? "";

			// Resolve title — falls back to first line of content
			const title =
				(opts.title as string) ??
				description.split("\n")[0]?.slice(0, 100) ??
				"Untitled";

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

			// Upload the video
			const videoId = await uploadVideo(auth, videoItem.url, {
				title,
				description,
				tags,
				categoryId,
				privacyStatus: effectivePrivacy,
				madeForKids,
				containsSyntheticMedia,
				publishAt,
				notifySubscribers,
			});

			// Set custom thumbnail if provided in media item
			const thumbnailItem = media.find((m) => m.type === "image");
			if (thumbnailItem) {
				try {
					await setThumbnail(auth, videoId, thumbnailItem.url);
				} catch {
					// Thumbnail failure should not fail the entire publish
					// Shorts do not support custom thumbnails via API
				}
			}

			// Post first comment if requested
			const firstComment = opts.first_comment as string | undefined;
			if (firstComment) {
				try {
					await postFirstComment(auth, videoId, request.account.platform_account_id, firstComment);
				} catch {
					// First comment failure should not fail the entire publish
				}
			}

			// Add to playlist if requested
			const playlistId = opts.playlist_id as string | undefined;
			if (playlistId) {
				try {
					await addToPlaylist(auth, playlistId, videoId);
				} catch {
					// Playlist failure should not fail the entire publish
				}
			}

			const platformUrl = `https://www.youtube.com/watch?v=${videoId}`;

			return {
				success: true,
				platform_post_id: videoId,
				platform_url: platformUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
