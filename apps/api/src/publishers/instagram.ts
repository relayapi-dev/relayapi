import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

// Instagram Login tokens (prefix "IGAA") must use graph.instagram.com
// Facebook Login tokens (prefix "EAAC") must use graph.facebook.com
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
//   "Host URLs: Instagram Login → graph.instagram.com, Facebook Login → graph.facebook.com"
function getGraphApi(accessToken: string): string {
	const host = accessToken.startsWith("IGAA")
		? "graph.instagram.com"
		: "graph.facebook.com";
	return `https://${host}/v25.0`;
}

interface InstagramAuth {
	access_token: string;
	user_id: string;
}

async function graphPost(
	endpoint: string,
	auth: InstagramAuth,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const url = `${getGraphApi(auth.access_token)}${endpoint}`;
	console.log(`[instagram-publisher] POST ${endpoint}`);
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string; type?: string; code?: number; error_subcode?: number };
		};
		const detail = err.error?.message ?? res.statusText;
		const subcode = err.error?.error_subcode;
		console.error(`[instagram-publisher] POST ${endpoint} failed: ${res.status} ${err.error?.message ?? "unknown"}`);

		// Classify Instagram-specific errors
		if (detail.includes("Error validating access token") || detail.includes("REVOKED_ACCESS_TOKEN") ||
			detail.includes("session has been invalidated") || err.error?.code === 190) {
			throw new Error(`TOKEN_EXPIRED: ${detail}`);
		}
		if (subcode === 2207042) {
			throw new Error(`RATE_LIMITED: Daily post limit reached`);
		}
		throw new Error(`Instagram API error: ${detail}`);
	}

	const result = await res.json() as Record<string, unknown>;
	console.log(`[instagram-publisher] POST ${endpoint} success: id=${result.id ?? "unknown"}`);
	return result;
}

async function graphGet(
	endpoint: string,
	auth: InstagramAuth,
	params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
	const searchParams = new URLSearchParams(params);
	const url = `${getGraphApi(auth.access_token)}${endpoint}?${searchParams.toString()}`;
	// Instagram Graph API: GET request to Facebook Graph API (used for Instagram)
	// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${auth.access_token}` },
	});

	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		throw new Error(`Instagram API error: ${detail}`);
	}

	return res.json() as Promise<Record<string, unknown>>;
}

/**
 * Create a media container for a single image, video, story, or reel.
 */
async function createMediaContainer(
	auth: InstagramAuth,
	params: Record<string, unknown>,
): Promise<string> {
	// Instagram Graph API: Create media container (step 1 of content publishing)
	// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
	const result = await graphPost(`/${auth.user_id}/media`, auth, params);
	return result.id as string;
}

/**
 * Poll a container's status until it reaches FINISHED or errors out.
 * Images typically finish in 2-5s, videos/reels can take minutes.
 * Uses escalating intervals: 2s, 5s, 10s, 30s, 60s, 60s, ...
 */
async function pollContainerStatus(
	auth: InstagramAuth,
	containerId: string,
	maxAttempts = 10,
): Promise<void> {
	const intervals = [2000, 5000, 10000, 30000, 60000];
	for (let i = 0; i < maxAttempts; i++) {
		const waitMs = intervals[Math.min(i, intervals.length - 1)];
		await new Promise((resolve) => setTimeout(resolve, waitMs));

		// Instagram Graph API: Check media container processing status
		// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
		const result = await graphGet(`/${containerId}`, auth, {
			fields: "status_code,status",
		});

		const status = result.status_code as string;
		console.log(`[instagram-publisher] Container ${containerId} status: ${status} (attempt ${i + 1}/${maxAttempts})`);

		if (status === "FINISHED") {
			return;
		}

		if (status === "ERROR") {
			const statusSubcode = result.status as string | undefined;
			const statusMessage = statusSubcode
				? `Container processing failed (subcode: ${statusSubcode})`
				: "Container processing failed";
			throw new Error(`Instagram media processing failed: ${statusMessage}`);
		}

		if (status === "EXPIRED") {
			throw new Error("Instagram media container expired before publishing.");
		}
	}

	throw new Error("Instagram media processing timed out");
}

/**
 * Publish a prepared media container.
 */
async function publishContainer(
	auth: InstagramAuth,
	containerId: string,
): Promise<string> {
	// Instagram Graph API: Publish a media container (step 2 of content publishing)
	// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing#step-2--publish-a-media-container
	const result = await graphPost(`/${auth.user_id}/media_publish`, auth, {
		creation_id: containerId,
	});
	return result.id as string;
}

/**
 * Fetch the permalink for a published media object.
 * Returns null if the request fails (non-fatal).
 */
async function fetchPermalink(
	auth: InstagramAuth,
	postId: string,
): Promise<string | null> {
	try {
		const result = await graphGet(`/${postId}`, auth, {
			fields: "permalink",
		});
		return (result.permalink as string) ?? null;
	} catch {
		return null;
	}
}

/**
 * Post a comment on a published post (used for first_comment).
 */
async function postFirstComment(
	auth: InstagramAuth,
	postId: string,
	message: string,
): Promise<void> {
	// Instagram Graph API: Post a comment on a published media object
	// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
	await graphPost(`/${postId}/comments`, auth, { message });
}

/**
 * Publish a single-image or single-video feed post.
 */
async function publishSingleMedia(
	auth: InstagramAuth,
	mediaUrl: string,
	mediaType: "IMAGE" | "VIDEO" | "REELS",
	caption?: string,
	extraParams?: Record<string, unknown>,
): Promise<string> {
	const params: Record<string, unknown> = {
		caption: caption ?? "",
		...extraParams,
	};

	if (mediaType === "IMAGE") {
		// IMAGE is the default — no media_type needed, just provide image_url
		params.image_url = mediaUrl;
	} else {
		// VIDEO, REELS, STORIES all require explicit media_type
		params.media_type = mediaType;
		params.video_url = mediaUrl;
	}

	// Instagram API: alt_text parameter for accessibility (max 1,000 chars)
	// Docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
	if (extraParams?.alt_text) {
		params.alt_text = (extraParams.alt_text as string).slice(0, 1000);
	}

	const containerId = await createMediaContainer(auth, params);

	// Poll until container is ready (images usually finish fast, videos take longer)
	await pollContainerStatus(auth, containerId);

	return publishContainer(auth, containerId);
}

/**
 * Publish a carousel post with up to 10 mixed images/videos.
 */
async function publishCarousel(
	auth: InstagramAuth,
	items: Array<{ url: string; type?: string }>,
	caption?: string,
	extraParams?: Record<string, unknown>,
): Promise<string> {
	// Step 1: Create child containers
	const childIds: string[] = [];

	for (const item of items.slice(0, 10)) {
		const isVideo = item.type === "video";
		// Carousel children should NOT include media_type — the API infers it from the URL param
		// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
		const childParams: Record<string, unknown> = {
			is_carousel_item: true,
		};

		if (isVideo) {
			childParams.video_url = item.url;
		} else {
			childParams.image_url = item.url;
		}

		// Alt text for carousel children
		if ((item as any).alt_text) {
			childParams.alt_text = ((item as any).alt_text as string).slice(0, 1000);
		}

		const childId = await createMediaContainer(auth, childParams);
		childIds.push(childId);
	}

	// Poll all children in parallel (images and videos both need processing)
	await Promise.all(childIds.map((id) => pollContainerStatus(auth, id)));

	// Step 2: Create parent carousel container
	// user_tags are only valid on child containers, not the carousel parent
	const { user_tags: _userTags, ...parentExtras } = extraParams ?? {};
	const parentParams: Record<string, unknown> = {
		media_type: "CAROUSEL",
		children: childIds.join(","),
		caption: caption ?? "",
		...parentExtras,
	};

	const parentId = await createMediaContainer(auth, parentParams);

	// Step 3: Poll until carousel container is ready
	await pollContainerStatus(auth, parentId);

	// Step 4: Publish the carousel
	return publishContainer(auth, parentId);
}

/**
 * Publish a story (image or video).
 */
async function publishStory(
	auth: InstagramAuth,
	mediaUrl: string,
	isVideo: boolean,
): Promise<string> {
	// Stories use the STORIES media_type
	const params: Record<string, unknown> = {
		media_type: "STORIES",
	};

	if (isVideo) {
		params.video_url = mediaUrl;
	} else {
		params.image_url = mediaUrl;
	}

	const containerId = await createMediaContainer(auth, params);

	// Poll all stories (both image and video) for consistency and robustness
	await pollContainerStatus(auth, containerId);

	return publishContainer(auth, containerId);
}

export const instagramPublisher: Publisher = {
	platform: "instagram",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const opts = request.target_options;
			const auth: InstagramAuth = {
				access_token: request.account.access_token,
				user_id: request.account.platform_account_id,
			};

			console.log(`[instagram-publisher] Publishing for account ${request.account.platform_account_id}, username=${request.account.username}, has_token=${!!auth.access_token}`);

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const contentType = opts.content_type as string | undefined;
			const firstComment = opts.first_comment as string | undefined;
			const shareToFeed = opts.share_to_feed as boolean | undefined;
			const collaborators = opts.collaborators as string[] | undefined;
			const userTags = opts.user_tags as
				| Array<{
						username: string;
						x: number;
						y: number;
						media_index?: number;
				  }>
				| undefined;
			const thumbOffset = opts.thumb_offset as number | undefined;

			// Instagram requires media for all post types
			if (media.length === 0) {
				return {
					success: false,
					error: {
						code: "MEDIA_REQUIRED",
						message:
							"Instagram requires at least one media attachment for all post types.",
					},
				};
			}

			// Validate caption length
			if (content.length > 2200) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Caption is ${content.length} characters. Instagram limit is 2,200.`,
					},
				};
			}

			let postId: string;

			// Build extra params for collaborators, user_tags, etc.
			const extraParams: Record<string, unknown> = {};
			if (collaborators && collaborators.length > 0) {
				extraParams.collaborators = collaborators;
			}
			if (userTags && userTags.length > 0) {
				extraParams.user_tags = userTags;
			}
			// Pass alt text from first media item
			const firstMedia = media[0];
			if (firstMedia && (firstMedia as any).alt_text) {
				extraParams.alt_text = (firstMedia as any).alt_text;
			}

			// Story
			if (contentType === "story") {
				const firstMedia = media[0];
				if (!firstMedia) throw new Error("No media found");
				const isVideo = firstMedia.type === "video";
				postId = await publishStory(auth, firstMedia.url, isVideo);
				const storyPermalink = await fetchPermalink(auth, postId);

				return {
					success: true,
					platform_post_id: postId,
					platform_url: storyPermalink ?? `https://www.instagram.com/stories/${request.account.username ?? auth.user_id}/`,
				};
			}

			// Reel
			if (contentType === "reels") {
				if (media[0]?.type !== "video") {
					return {
						success: false,
						error: {
							code: "VIDEO_REQUIRED",
							message: "Instagram reels require a video attachment.",
						},
					};
				}

				const reelParams: Record<string, unknown> = { ...extraParams };
				if (shareToFeed !== undefined) {
					reelParams.share_to_feed = shareToFeed;
				}
				if (thumbOffset !== undefined) {
					reelParams.thumb_offset = thumbOffset;
				}

				postId = await publishSingleMedia(
					auth,
					media[0]?.url,
					"REELS",
					content || undefined,
					reelParams,
				);

				// First comment on reels
				if (firstComment) {
					try {
						await postFirstComment(auth, postId, firstComment);
					} catch {
						// Non-fatal
					}
				}

				const reelPermalink = await fetchPermalink(auth, postId);
				return {
					success: true,
					platform_post_id: postId,
					platform_url: reelPermalink ?? `https://www.instagram.com/reel/${postId}/`,
				};
			}

			// Carousel (multiple media items)
			if (media.length > 1) {
				postId = await publishCarousel(
					auth,
					media,
					content || undefined,
					extraParams,
				);

				if (firstComment) {
					try {
						await postFirstComment(auth, postId, firstComment);
					} catch {
						// Non-fatal
					}
				}

				const carouselPermalink = await fetchPermalink(auth, postId);
				return {
					success: true,
					platform_post_id: postId,
					platform_url: carouselPermalink ?? `https://www.instagram.com/p/${postId}/`,
				};
			}

			// Single image or video feed post
			if (!firstMedia) throw new Error("No media found");
			const isVideo = firstMedia.type === "video";

			// Instagram deprecated standalone video feed posts — all videos become Reels
			// The formal endpoint reference only lists CAROUSEL, REELS, STORIES as valid media_type values
			postId = await publishSingleMedia(
				auth,
				firstMedia.url,
				isVideo ? "REELS" : "IMAGE",
				content || undefined,
				extraParams,
			);

			// First comment
			if (firstComment) {
				try {
					await postFirstComment(auth, postId, firstComment);
				} catch {
					// Non-fatal
				}
			}

			const mediaPermalink = await fetchPermalink(auth, postId);
			const fallbackUrl = isVideo
				? `https://www.instagram.com/reel/${postId}/`
				: `https://www.instagram.com/p/${postId}/`;
			return {
				success: true,
				platform_post_id: postId,
				platform_url: mediaPermalink ?? fallbackUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
