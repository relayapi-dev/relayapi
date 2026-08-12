import { API_VERSIONS } from "../config/api-versions";
import { InstagramTargetOptions } from "../schemas/publisher-options";
import { readPublisherJson } from "./provider-response";
import {
	classifyPublishError,
	getSucceededProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	recordProviderEffect,
} from "./types";

const DEBUG = false;

// Instagram Login tokens (prefix "IGAA") must use graph.instagram.com
// Facebook Login tokens (prefix "EAAC") must use graph.facebook.com
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
//   "Host URLs: Instagram Login → graph.instagram.com, Facebook Login → graph.facebook.com"
function getGraphApi(accessToken: string): string {
	const host = accessToken.startsWith("IGAA")
		? "graph.instagram.com"
		: "graph.facebook.com";
	return `https://${host}/${API_VERSIONS.meta_graph}`;
}

interface InstagramAuth {
	access_token: string;
	user_id: string;
}

interface InstagramUserTag {
	username: string;
	x: number;
	y: number;
	/** Relay-only selector; it is not sent to Meta. */
	media_index?: number;
}

function userTagsForMedia(
	tags: readonly InstagramUserTag[] | undefined,
	mediaIndex: number,
): Array<Omit<InstagramUserTag, "media_index">> {
	return (tags ?? [])
		.filter(
			(tag) =>
				tag.media_index === mediaIndex ||
				(tag.media_index === undefined && mediaIndex === 0),
		)
		.map(({ media_index: _mediaIndex, ...providerTag }) => providerTag);
}

async function graphPost(
	endpoint: string,
	auth: InstagramAuth,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const url = `${getGraphApi(auth.access_token)}${endpoint}`;
	if (DEBUG) console.log(`[instagram-publisher] POST ${endpoint}`);
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: {
				message?: string;
				type?: string;
				code?: number;
				error_subcode?: number;
			};
		};
		const detail = err.error?.message ?? res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const subcode = err.error?.error_subcode;
		if (DEBUG)
			console.error(
				`[instagram-publisher] POST ${endpoint} failed: ${res.status} ${err.error?.message ?? "unknown"}`,
			);

		// Classify Instagram-specific errors
		if (
			detail.includes("Error validating access token") ||
			detail.includes("REVOKED_ACCESS_TOKEN") ||
			detail.includes("session has been invalidated") ||
			err.error?.code === 190
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (subcode === 2207042) {
			throw new PublishError(`RATE_LIMITED: Daily post limit reached`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		throw new PublishError(`Instagram API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	const result = (await readPublisherJson(res)) as Record<string, unknown>;
	if (DEBUG)
		console.log(
			`[instagram-publisher] POST ${endpoint} success: id=${result.id ?? "unknown"}`,
		);
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
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(`Instagram API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	return readPublisherJson(res) as Promise<Record<string, unknown>>;
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
		if (DEBUG)
			console.log(
				`[instagram-publisher] Container ${containerId} status: ${status} (attempt ${i + 1}/${maxAttempts})`,
			);

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
): Promise<string> {
	// Instagram Graph API: Post a comment on a published media object
	// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
	const result = await graphPost(`/${postId}/comments`, auth, { message });
	return result.id as string;
}

async function publishFirstCommentOnce(
	request: PublishRequest,
	auth: InstagramAuth,
	postId: string,
	message: string,
): Promise<void> {
	if (getSucceededProviderEffect(request, "first_comment")) return;
	let commentId: string;
	try {
		commentId = await postFirstComment(auth, postId, message);
	} catch {
		// The primary post is already visible, so a provider-side comment rejection
		// remains non-fatal. Recorder failures below are deliberately not swallowed.
		return;
	}
	await recordProviderEffect(request, {
		name: "first_comment",
		status: "succeeded",
		provider_id: commentId,
	});
}

/**
 * Publish a single-image or single-video feed post.
 */
async function publishSingleMedia(
	request: PublishRequest,
	auth: InstagramAuth,
	mediaUrl: string,
	mediaType: "IMAGE" | "VIDEO" | "REELS",
	caption?: string,
	extraParams?: Record<string, unknown>,
): Promise<string> {
	const published = getSucceededProviderEffect(request, "post_published");
	if (published?.provider_id) return published.provider_id;
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

	let containerId = getSucceededProviderEffect(
		request,
		"media_container",
	)?.provider_id;
	if (!containerId) {
		containerId = await createMediaContainer(auth, params);
		await recordProviderEffect(request, {
			name: "media_container",
			status: "succeeded",
			provider_id: containerId,
		});
	}

	// Poll until container is ready (images usually finish fast, videos take longer)
	await pollContainerStatus(auth, containerId);

	const postId = await publishContainer(auth, containerId);
	await recordProviderEffect(request, {
		name: "post_published",
		status: "succeeded",
		provider_id: postId,
	});
	return postId;
}

/**
 * Publish a carousel post with up to 10 mixed images/videos.
 */
async function publishCarousel(
	request: PublishRequest,
	auth: InstagramAuth,
	items: Array<{ url: string; type?: string; alt_text?: string }>,
	caption?: string,
	extraParams?: Record<string, unknown>,
): Promise<string> {
	const published = getSucceededProviderEffect(request, "post_published");
	if (published?.provider_id) return published.provider_id;
	if (items.length < 2 || items.length > 10) {
		// Official Meta docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
		// Section "Create a carousel container" > "Limitations" says carousels
		// are limited to 10 items. The minimum of two is RelayAPI's defensive
		// distinction between this path and the single-media publishing path.
		throw new Error(
			`CONTENT_ERROR: Instagram carousels require 2-10 media items; received ${items.length}.`,
		);
	}

	// Step 1: Create child containers
	const childIds: string[] = [];

	const carouselUserTags = Array.isArray(extraParams?.user_tags)
		? (extraParams.user_tags as InstagramUserTag[])
		: undefined;
	for (const [mediaIndex, item] of items.entries()) {
		const isVideo = item.type === "video";
		const childParams: Record<string, unknown> = {
			is_carousel_item: true,
		};

		if (isVideo) {
			// Official Meta docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
			// Example "Create carousel video container" uses `media_type=VIDEO`,
			// `video_url`, and `is_carousel_item=true` are explicit parameters.
			childParams.media_type = "VIDEO";
			childParams.video_url = item.url;
		} else {
			childParams.image_url = item.url;
		}

		// Alt text for carousel children
		const itemAltText = item.alt_text;
		if (itemAltText) {
			childParams.alt_text = itemAltText.slice(0, 1000);
		}
		const childUserTags = userTagsForMedia(carouselUserTags, mediaIndex);
		if (childUserTags.length > 0) {
			childParams.user_tags = childUserTags;
		}

		const effectName = `carousel_child_${mediaIndex + 1}`;
		let childId = getSucceededProviderEffect(request, effectName)?.provider_id;
		if (!childId) {
			childId = await createMediaContainer(auth, childParams);
			await recordProviderEffect(request, {
				name: effectName,
				status: "succeeded",
				provider_id: childId,
			});
		}
		childIds.push(childId);
	}

	// Poll all children in parallel (images and videos both need processing)
	await Promise.all(childIds.map((id) => pollContainerStatus(auth, id)));

	// Step 2: Create parent carousel container
	// user_tags are only valid on child containers, not the carousel parent
	const {
		user_tags: _userTags,
		alt_text: _altText,
		...parentExtras
	} = extraParams ?? {};
	const parentParams: Record<string, unknown> = {
		media_type: "CAROUSEL",
		children: childIds.join(","),
		caption: caption ?? "",
		...parentExtras,
	};

	let parentId = getSucceededProviderEffect(
		request,
		"carousel_container",
	)?.provider_id;
	if (!parentId) {
		parentId = await createMediaContainer(auth, parentParams);
		await recordProviderEffect(request, {
			name: "carousel_container",
			status: "succeeded",
			provider_id: parentId,
		});
	}

	// Step 3: Poll until carousel container is ready
	await pollContainerStatus(auth, parentId);

	// Step 4: Publish the carousel
	const postId = await publishContainer(auth, parentId);
	await recordProviderEffect(request, {
		name: "post_published",
		status: "succeeded",
		provider_id: postId,
	});
	return postId;
}

/**
 * Publish a story (image or video).
 */
async function publishStory(
	request: PublishRequest,
	auth: InstagramAuth,
	mediaUrl: string,
	isVideo: boolean,
): Promise<string> {
	const published = getSucceededProviderEffect(request, "post_published");
	if (published?.provider_id) return published.provider_id;
	// Stories use the STORIES media_type
	const params: Record<string, unknown> = {
		media_type: "STORIES",
	};

	if (isVideo) {
		params.video_url = mediaUrl;
	} else {
		params.image_url = mediaUrl;
	}

	let containerId = getSucceededProviderEffect(
		request,
		"media_container",
	)?.provider_id;
	if (!containerId) {
		containerId = await createMediaContainer(auth, params);
		await recordProviderEffect(request, {
			name: "media_container",
			status: "succeeded",
			provider_id: containerId,
		});
	}

	// Poll all stories (both image and video) for consistency and robustness
	await pollContainerStatus(auth, containerId);

	const postId = await publishContainer(auth, containerId);
	await recordProviderEffect(request, {
		name: "post_published",
		status: "succeeded",
		provider_id: postId,
	});
	return postId;
}

export const instagramPublisher: Publisher = {
	platform: "instagram",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const parsedOptions = InstagramTargetOptions.safeParse(
				request.target_options,
			);
			if (!parsedOptions.success) {
				const issue = parsedOptions.error.issues[0];
				const path = issue?.path.length ? ` ${issue.path.join(".")}` : "";
				return {
					success: false,
					error: {
						code: "INVALID_INSTAGRAM_TARGET_OPTIONS",
						message: `Invalid Instagram target option${path}: ${issue?.message ?? "validation failed"}.`,
					},
				};
			}
			const opts = parsedOptions.data;
			const auth: InstagramAuth = {
				access_token: request.account.access_token,
				user_id: request.account.platform_account_id,
			};

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const contentType = opts.content_type as string | undefined;
			const firstComment = opts.first_comment as string | undefined;
			const shareToFeed = opts.share_to_feed as boolean | undefined;
			const collaborators = opts.collaborators as string[] | undefined;
			const userTags = opts.user_tags as InstagramUserTag[] | undefined;
			const thumbOffset = opts.thumb_offset as number | undefined;
			const coverUrl = opts.cover_url as string | undefined;
			const coverMediaId = opts.cover_media_id as string | undefined;
			const coverVariantId = opts.cover_variant_id as string | undefined;
			const trialParams = opts.trial_params as
				| { graduation_strategy?: unknown }
				| undefined;
			const coverSources = [
				coverUrl,
				coverMediaId,
				coverVariantId,
				thumbOffset,
			].filter((value) => value !== undefined);

			// Official Meta reference: https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
			// Fields `cover_url` and `trial_params` are valid only for REELS;
			// trial_params.graduation_strategy is MANUAL or SS_PERFORMANCE.
			if ((coverSources.length > 0 || trialParams) && contentType !== "reels") {
				return {
					success: false,
					error: {
						code: "REELS_OPTION_REQUIRES_REEL",
						message:
							"Instagram cover options and trial_params require content_type reels.",
					},
				};
			}
			if (coverSources.length > 1) {
				return {
					success: false,
					error: {
						code: "AMBIGUOUS_REEL_COVER",
						message:
							"Choose exactly one Instagram Reel cover source: cover_url, cover_media_id, cover_variant_id, or thumb_offset.",
					},
				};
			}
			if (coverMediaId || coverVariantId) {
				return {
					success: false,
					error: {
						code: "COVER_SELECTOR_UNRESOLVED",
						message:
							"Relay cover selectors must be resolved to a fresh cover_url immediately before Instagram publishing.",
					},
				};
			}
			if (
				trialParams &&
				trialParams.graduation_strategy !== "MANUAL" &&
				trialParams.graduation_strategy !== "SS_PERFORMANCE"
			) {
				return {
					success: false,
					error: {
						code: "INVALID_TRIAL_PARAMS",
						message:
							"Instagram Trial Reels require graduation_strategy MANUAL or SS_PERFORMANCE.",
					},
				};
			}

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

			if (
				(contentType === "story" || contentType === "reels") &&
				media.length !== 1
			) {
				// Official Meta docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user/media
				// Sections "Create image container" / "Create video container"
				// accept one image_url or video_url; multiple assets use CAROUSEL.
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message: `Instagram ${contentType} posts require exactly one media attachment.`,
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
			const firstMediaAltText = (
				firstMedia as { alt_text?: string } | undefined
			)?.alt_text;
			if (firstMediaAltText) {
				extraParams.alt_text = firstMediaAltText;
			}

			// Story
			if (contentType === "story") {
				const firstMedia = media[0];
				if (!firstMedia) throw new Error("No media found");
				const isVideo = firstMedia.type === "video";
				postId = await publishStory(request, auth, firstMedia.url, isVideo);
				const storyPermalink = await fetchPermalink(auth, postId);

				return {
					success: true,
					platform_post_id: postId,
					platform_url:
						storyPermalink ??
						`https://www.instagram.com/stories/${request.account.username ?? auth.user_id}/`,
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
				const reelUserTags = userTagsForMedia(userTags, 0);
				if (reelUserTags.length > 0) {
					reelParams.user_tags = reelUserTags;
				}
				if (shareToFeed !== undefined) {
					reelParams.share_to_feed = shareToFeed;
				}
				if (thumbOffset !== undefined) {
					reelParams.thumb_offset = thumbOffset;
				}
				if (coverUrl) {
					reelParams.cover_url = coverUrl;
				}
				if (trialParams) {
					reelParams.trial_params = trialParams;
				}

				postId = await publishSingleMedia(
					request,
					auth,
					media[0]?.url,
					"REELS",
					content || undefined,
					reelParams,
				);

				// First comment on reels
				if (firstComment)
					await publishFirstCommentOnce(request, auth, postId, firstComment);

				const reelPermalink = await fetchPermalink(auth, postId);
				return {
					success: true,
					platform_post_id: postId,
					platform_url:
						reelPermalink ?? `https://www.instagram.com/reel/${postId}/`,
				};
			}

			// Carousel (multiple media items)
			if (media.length > 1) {
				postId = await publishCarousel(
					request,
					auth,
					media,
					content || undefined,
					extraParams,
				);

				if (firstComment)
					await publishFirstCommentOnce(request, auth, postId, firstComment);

				const carouselPermalink = await fetchPermalink(auth, postId);
				return {
					success: true,
					platform_post_id: postId,
					platform_url:
						carouselPermalink ?? `https://www.instagram.com/p/${postId}/`,
				};
			}

			// Single image or video feed post
			if (!firstMedia) throw new Error("No media found");
			const isVideo = firstMedia.type === "video";

			// Instagram deprecated standalone video feed posts — all videos become Reels
			// The formal endpoint reference only lists CAROUSEL, REELS, STORIES as valid media_type values
			const singleParams: Record<string, unknown> = { ...extraParams };
			const singleUserTags = userTagsForMedia(userTags, 0);
			if (singleUserTags.length > 0) {
				singleParams.user_tags = singleUserTags;
			}
			postId = await publishSingleMedia(
				request,
				auth,
				firstMedia.url,
				isVideo ? "REELS" : "IMAGE",
				content || undefined,
				singleParams,
			);

			// First comment
			if (firstComment)
				await publishFirstCommentOnce(request, auth, postId, firstComment);

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
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
