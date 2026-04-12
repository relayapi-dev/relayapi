import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type EngagementAccount, type EngagementActionResult, type Publisher, type PublishRequest, type PublishResult } from "./types";

const GRAPH_API = "https://graph.facebook.com/v25.0";

interface FacebookAuth {
	access_token: string;
	page_id: string;
}

async function graphFetch(
	url: string,
	auth: FacebookAuth,
	options: RequestInit = {},
): Promise<Response> {
	const separator = url.includes("?") ? "&" : "?";
	return fetch(`${url}${separator}access_token=${auth.access_token}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
}

async function graphPost(
	endpoint: string,
	auth: FacebookAuth,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await graphFetch(`${GRAPH_API}${endpoint}`, auth, {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string; code?: number; error_subcode?: number };
		};
		const detail = err.error?.message ?? res.statusText;
		const fbCode = err.error?.code;
		const subcode = err.error?.error_subcode;

		// Classify Facebook-specific errors for retry/refresh decisions
		// Docs: https://developers.facebook.com/docs/graph-api/guides/error-handling
		if (detail.includes("Error validating access token") || detail.includes("REVOKED_ACCESS_TOKEN") ||
			subcode === 490 || subcode === 463 || subcode === 464 || subcode === 467 || fbCode === 190) {
			throw new Error(`TOKEN_EXPIRED: ${detail}`);
		}
		if (subcode === 1390008 || fbCode === 32 || fbCode === 4 || fbCode === 17) {
			throw new Error(`RATE_LIMITED: ${detail}`);
		}
		if (fbCode === 368) {
			throw new Error(`PLATFORM_ERROR: Temporarily blocked — ${detail}`);
		}
		throw new Error(`Facebook API error: ${detail}`);
	}

	return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Create a text-only feed post.
 */
async function createTextPost(
	auth: FacebookAuth,
	message: string,
): Promise<{ id: string; permalink_url?: string }> {
	// Facebook Graph API: Create page feed post (read-after-write for permalink_url)
	// Docs: https://developers.facebook.com/docs/pages-api/posts
	const result = await graphPost(`/${auth.page_id}/feed?fields=id,permalink_url`, auth, { message });
	return { id: result.id as string, permalink_url: result.permalink_url as string | undefined };
}

/**
 * Upload a single photo. When `published` is false the photo is staged
 * for inclusion in a multi-image post.
 */
async function uploadPhoto(
	auth: FacebookAuth,
	imageUrl: string,
	message?: string,
	published = true,
): Promise<{ id: string; post_id?: string }> {
	const body: Record<string, unknown> = {
		url: imageUrl,
		published,
	};
	if (message) {
		body.caption = message;
	}

	// Facebook Graph API: Upload photo to page
	// Docs: https://developers.facebook.com/docs/graph-api/reference/page/photos/
	const result = await graphPost(`/${auth.page_id}/photos`, auth, body);
	return {
		id: result.id as string,
		post_id: result.post_id as string | undefined,
	};
}

/**
 * Publish a single-image post. Returns the photo post ID.
 */
async function createSingleImagePost(
	auth: FacebookAuth,
	imageUrl: string,
	message?: string,
): Promise<{ id: string }> {
	const result = await uploadPhoto(auth, imageUrl, message, true);
	// For published photos, the post_id is the feed post; fall back to id
	return { id: result.post_id ?? result.id };
}

/**
 * Publish a multi-image post. Uploads each image unpublished, then creates
 * a feed post referencing all of them.
 */
async function createMultiImagePost(
	auth: FacebookAuth,
	imageUrls: string[],
	message?: string,
): Promise<{ id: string; permalink_url?: string }> {
	// Upload each image as unpublished
	const uploads = await Promise.all(
		imageUrls.map((url) => uploadPhoto(auth, url, undefined, false)),
	);

	// Create feed post with attached_media using indexed URL-encoded format
	// Facebook requires attached_media[0]=..., attached_media[1]=... format
	// JSON arrays are fragile and cause "(#100) param attached_media must be an array" errors
	// Docs: https://developers.facebook.com/docs/pages-api/posts
	const params = new URLSearchParams();
	params.append("access_token", auth.access_token);
	if (message) {
		params.append("message", message);
	}
	for (let i = 0; i < uploads.length; i++) {
		params.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: uploads[i]!.id }));
	}

	const res = await fetch(`${GRAPH_API}/${auth.page_id}/feed?fields=id,permalink_url`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		throw new Error(`Facebook API error: ${detail}`);
	}

	const result = (await res.json()) as Record<string, unknown>;
	return { id: result.id as string, permalink_url: result.permalink_url as string | undefined };
}

/**
 * Upload and publish a video post.
 */
async function createVideoPost(
	auth: FacebookAuth,
	videoUrl: string,
	description?: string,
): Promise<{ id: string; permalink_url?: string }> {
	const body: Record<string, unknown> = { file_url: videoUrl };
	if (description) {
		body.description = description;
	}

	// Facebook Graph API: Upload and publish video to page via file_url
	// https://developers.facebook.com/docs/graph-api/reference/page/videos/
	const result = await graphPost(`/${auth.page_id}/videos?fields=id,permalink_url`, auth, body);
	return { id: result.id as string, permalink_url: result.permalink_url as string | undefined };
}

/**
 * Publish a photo story.
 * 1. Upload photo as unpublished to get photo_id
 * 2. Create photo story using the photo_id
 * https://developers.facebook.com/docs/pages-api/posts
 */
async function createPhotoStory(
	auth: FacebookAuth,
	imageUrl: string,
): Promise<{ id: string }> {
	// Step 1: Upload photo as unpublished
	const photo = await uploadPhoto(auth, imageUrl, undefined, false);

	// Step 2: Create photo story using photo_id
	const result = await graphPost(`/${auth.page_id}/photo_stories`, auth, {
		photo_id: photo.id,
	});
	return { id: (result.post_id as string) ?? (result.id as string) };
}

/**
 * Publish a video story using the multi-step upload flow:
 * 1. POST /{page-id}/video_stories with upload_phase=start → get video_id + upload_url
 * 2. POST video binary to the upload_url
 * 3. POST /{page-id}/video_stories with upload_phase=finish + video_id
 * https://developers.facebook.com/docs/pages-api/posts
 */
async function createVideoStory(
	auth: FacebookAuth,
	videoUrl: string,
): Promise<{ id: string }> {
	// Step 1: Start upload
	const startResult = await graphPost(`/${auth.page_id}/video_stories`, auth, {
		upload_phase: "start",
	});
	const videoId = startResult.video_id as string;
	const uploadUrl = startResult.upload_url as string;

	// Step 2: Upload binary to the upload_url
	const videoRes = await fetchPublicUrl(videoUrl, { timeout: 30_000 });
	if (!videoRes.ok) {
		throw new Error(
			`Failed to fetch story video from ${videoUrl}: ${videoRes.statusText}`,
		);
	}
	const videoBlob = await videoRes.arrayBuffer();

	const uploadRes = await fetch(uploadUrl, {
		method: "POST",
		headers: {
			Authorization: `OAuth ${auth.access_token}`,
			"Content-Type": "application/octet-stream",
			file_size: videoBlob.byteLength.toString(),
			offset: "0",
		},
		body: videoBlob,
	});
	if (!uploadRes.ok) {
		throw new Error(`Facebook video story upload failed: ${uploadRes.statusText}`);
	}

	// Step 3: Finish upload
	const finishResult = await graphPost(`/${auth.page_id}/video_stories`, auth, {
		upload_phase: "finish",
		video_id: videoId,
	});
	return { id: (finishResult.post_id as string) ?? (finishResult.id as string) ?? videoId };
}

/**
 * Publish a Reel using the two-phase upload flow:
 * 1. POST /{page-id}/video_reels with upload_phase=start
 * 2. PUT the video binary to the returned upload_url
 * 3. POST /{page-id}/video_reels with upload_phase=finish
 */
async function createReel(
	auth: FacebookAuth,
	videoUrl: string,
	description?: string,
	title?: string,
): Promise<{ id: string }> {
	// Facebook Graph API: Start reel upload (phase 1)
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	const startResult = await graphPost(`/${auth.page_id}/video_reels`, auth, {
		upload_phase: "start",
	});
	const videoId = startResult.video_id as string;
	const uploadUrl = startResult.upload_url as string;

	// Fetch the video binary from source URL
	const videoRes = await fetchPublicUrl(videoUrl, { timeout: 30_000 });
	if (!videoRes.ok) {
		throw new Error(
			`Failed to fetch reel video from ${videoUrl}: ${videoRes.statusText}`,
		);
	}
	const videoBlob = await videoRes.arrayBuffer();
	const contentType = videoRes.headers.get("content-type") ?? "video/mp4";

	// Facebook Graph API: Upload reel video binary (phase 2)
	// Method must be POST, Content-Type must be application/octet-stream, offset header required
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	const uploadRes = await fetch(uploadUrl, {
		method: "POST",
		headers: {
			Authorization: `OAuth ${auth.access_token}`,
			"Content-Type": "application/octet-stream",
			offset: "0",
			file_size: videoBlob.byteLength.toString(),
		},
		body: videoBlob,
	});
	if (!uploadRes.ok) {
		throw new Error(`Facebook reel upload failed: ${uploadRes.statusText}`);
	}

	// Facebook Graph API: Finish reel upload (phase 3)
	// video_state: "PUBLISHED" is required to actually publish the reel
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	const finishBody: Record<string, unknown> = {
		upload_phase: "finish",
		video_id: videoId,
		video_state: "PUBLISHED",
	};
	if (description) {
		finishBody.description = description;
	}
	if (title) {
		finishBody.title = title;
	}

	const finishResult = await graphPost(`/${auth.page_id}/video_reels`, auth, finishBody);
	return { id: (finishResult.post_id as string) ?? videoId };
}

/**
 * Post a comment on a published post.
 */
async function postFirstComment(
	auth: FacebookAuth,
	postId: string,
	message: string,
): Promise<void> {
	// Facebook Graph API: Post a comment on a published object
	// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
	await graphPost(`/${postId}/comments`, auth, { message });
}

export const facebookPublisher: Publisher = {
	platform: "facebook",

	async comment(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const auth: FacebookAuth = {
				access_token: account.access_token,
				page_id: account.platform_account_id,
			};
			// Facebook Graph API: Post a comment on a published object
			// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
			const result = await graphPost(`/${platformPostId}/comments`, auth, { message: text });
			return { success: true, platform_post_id: result.id as string };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const opts = request.target_options;
			const pageId =
				(opts.page_id as string) ?? request.account.platform_account_id;
			const auth: FacebookAuth = {
				access_token: request.account.access_token,
				page_id: pageId,
			};

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const contentType = opts.content_type as string | undefined;
			const firstComment = opts.first_comment as string | undefined;
			const title = opts.title as string | undefined;

			let postId: string;
			let permalinkUrl: string | undefined;

			// Determine content type
			if (contentType === "story") {
				// Story — requires exactly one media item
				if (media.length === 0) {
					return {
						success: false,
						error: {
							code: "MEDIA_REQUIRED",
							message:
								"Facebook stories require at least one media attachment.",
						},
					};
				}

				const firstMedia = media[0];
				if (!firstMedia) throw new Error("No media found");
				if (firstMedia.type === "video") {
					const result = await createVideoStory(auth, firstMedia.url);
					postId = result.id;
				} else {
					const result = await createPhotoStory(auth, firstMedia.url);
					postId = result.id;
				}

				return {
					success: true,
					platform_post_id: postId,
					platform_url: `https://www.facebook.com/${pageId}`,
				};
			}

			if (contentType === "reel") {
				// Reel — requires exactly one video
				if (media.length === 0 || media[0]?.type !== "video") {
					return {
						success: false,
						error: {
							code: "VIDEO_REQUIRED",
							message: "Facebook reels require exactly one video attachment.",
						},
					};
				}

				const result = await createReel(
					auth,
					media[0]?.url,
					content || undefined,
					title,
				);
				postId = result.id;

				return {
					success: true,
					platform_post_id: postId,
					platform_url: `https://www.facebook.com/reel/${postId}`,
				};
			}

			// Feed post
			const images = media.filter(
				(m) => !m.type || m.type === "image" || m.type === "gif",
			);
			const videos = media.filter((m) => m.type === "video");

			if (images.length > 0 && videos.length > 0) {
				return {
					success: false,
					error: {
						code: "INVALID_MEDIA",
						message:
							"Facebook does not allow mixing images and videos in the same post.",
					},
				};
			}

			if (videos.length > 0) {
				// Video post (single video only)
				const result = await createVideoPost(
					auth,
					videos[0]?.url ?? "",
					content || undefined,
				);
				postId = result.id;
				permalinkUrl = result.permalink_url;
			} else if (images.length > 1) {
				// Multi-image post
				const result = await createMultiImagePost(
					auth,
					images.map((m) => m.url),
					content || undefined,
				);
				postId = result.id;
				permalinkUrl = result.permalink_url;
			} else if (images.length === 1) {
				// Single image post
				const result = await createSingleImagePost(
					auth,
					images[0]?.url ?? "",
					content || undefined,
				);
				postId = result.id;
			} else {
				// Text-only post
				if (!content) {
					return {
						success: false,
						error: {
							code: "CONTENT_REQUIRED",
							message: "Facebook text posts require content.",
						},
					};
				}
				const result = await createTextPost(auth, content);
				postId = result.id;
				permalinkUrl = result.permalink_url;
			}

			// First comment (feed posts only)
			if (firstComment) {
				try {
					await postFirstComment(auth, postId, firstComment);
				} catch {
					// Non-fatal — the post was already published
				}
			}

			// Use permalink_url from API response when available, fall back to constructed URL
			// Post IDs are typically PAGEID_POSTID format
			const parts = postId.split("_");
			const fallbackUrl = parts.length === 2
				? `https://www.facebook.com/${parts[0]}/posts/${parts[1]}`
				: `https://www.facebook.com/${auth.page_id}/posts/${postId}`;
			const platformUrl = permalinkUrl ?? fallbackUrl;

			return {
				success: true,
				platform_post_id: postId,
				platform_url: platformUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
