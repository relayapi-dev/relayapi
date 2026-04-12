import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const TIKTOK_API = "https://open.tiktokapis.com/v2";

async function tiktokFetch(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json; charset=UTF-8",
			...(options.headers ?? {}),
		},
	});
	if (res.status === 401) throw new Error("TOKEN_EXPIRED: TikTok access token invalid or expired");
	if (res.status === 429) throw new Error("RATE_LIMITED: TikTok rate limit exceeded");
	return res;
}

interface TikTokPublishResponse {
	data?: {
		publish_id?: string;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

interface TikTokStatusResponse {
	data?: {
		status?: string;
		publicaly_available_post_id?: string[];
		fail_reason?: string;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

async function pollPublishStatus(
	accessToken: string,
	publishId: string,
	maxAttempts = 30,
	intervalMs = 5000,
): Promise<TikTokStatusResponse> {
	let httpFailures = 0;
	for (let i = 0; i < maxAttempts; i++) {
		if (i > 0) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}

		// TikTok Content Posting API — Fetch publish status
		// https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
		const res = await tiktokFetch(
			`${TIKTOK_API}/post/publish/status/fetch/`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({ publish_id: publishId }),
			},
		);

		if (!res.ok) {
			httpFailures++;
			if (httpFailures >= 5) {
				throw new Error(
					`TikTok publish status polling failed after ${httpFailures} consecutive HTTP errors (last status: ${res.status}).`,
				);
			}
			continue;
		}

		httpFailures = 0;

		const status = (await res.json()) as TikTokStatusResponse;

		if (status.error?.code && status.error.code !== "ok") {
			return status;
		}

		const publishStatus = status.data?.status;

		if (publishStatus === "PUBLISH_COMPLETE") {
			return status;
		}

		// SEND_TO_USER_INBOX means the content was sent to the user's inbox for further editing
		if (publishStatus === "SEND_TO_USER_INBOX") {
			return status;
		}

		if (publishStatus === "FAILED") {
			return status;
		}

		// PROCESSING_UPLOAD or PROCESSING_DOWNLOAD — keep polling
	}

	return {
		error: {
			code: "POLL_TIMEOUT",
			message: "TikTok publish status polling timed out.",
		},
	};
}

export const tiktokPublisher: Publisher = {
	platform: "tiktok",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			const opts = request.target_options;

			// Resolve media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// TikTok requires media — no text-only posts
			if (media.length === 0) {
				return {
					success: false,
					error: {
						code: "MEDIA_REQUIRED",
						message:
							"TikTok requires video or photo media. Text-only posts are not supported.",
					},
				};
			}

			// Determine if this is a video or photo post
			const hasVideo = media.some((m) => m.type === "video");
			const hasImages = media.some((m) => !m.type || m.type === "image");

			// Cannot mix photos and videos
			if (hasVideo && hasImages) {
				return {
					success: false,
					error: {
						code: "MIXED_MEDIA",
						message:
							"TikTok does not allow mixing photos and videos in the same post.",
					},
				};
			}

			// Video: only 1 video allowed
			if (hasVideo && media.length > 1) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_VIDEOS",
						message: "TikTok supports a maximum of 1 video per post.",
					},
				};
			}

			// Photos: max 35
			if (hasImages && media.length > 35) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_PHOTOS",
						message: `TikTok supports a maximum of 35 photos per carousel. Got ${media.length}.`,
					},
				};
			}

			// Required options
			const privacyLevel = opts.privacy_level as string | undefined;
			if (!privacyLevel) {
				return {
					success: false,
					error: {
						code: "PRIVACY_LEVEL_REQUIRED",
						message: "TikTok requires privacy_level in target_options.",
					},
				};
			}

			const allowComment = (opts.allow_comment as boolean | undefined) ?? true;

			// Resolve content/description
			const content = (opts.content as string) ?? request.content ?? "";

			const username = request.account.username;

			let result: PublishResult;
			if (hasVideo) {
				result = await publishVideo(
					accessToken,
					media[0]?.url ?? "",
					content,
					opts,
					privacyLevel,
					allowComment,
				);
			} else {
				result = await publishPhotos(
					accessToken,
					media.map((m) => m.url),
					content,
					opts,
					privacyLevel,
					allowComment,
				);
			}

			// Build platform URL
			if (result.success && username) {
				if (result.platform_post_id && result.platform_url === undefined) {
					// Only construct video URL if we have a real post ID (not the publish_id)
					result.platform_url = `https://www.tiktok.com/@${username}/video/${result.platform_post_id}`;
				} else if (!result.platform_url) {
					// Fallback to profile URL when no real post ID is available
					result.platform_url = `https://www.tiktok.com/@${username}`;
				}
			}

			return result;
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};

async function publishVideo(
	accessToken: string,
	videoUrl: string,
	content: string,
	opts: Record<string, unknown>,
	privacyLevel: string,
	allowComment: boolean,
): Promise<PublishResult> {
	// Validate video caption length
	const caption = (opts.description as string | undefined) ?? content;
	if (caption.length > 2200) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Video caption is ${caption.length} characters. TikTok limit is 2,200.`,
			},
		};
	}

	// Validate video size: TikTok max 4GB
	// Docs: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
	// Note: We can't check file size for PULL_FROM_URL without downloading,
	// so we rely on TikTok's server-side validation for this.

	const postInfo: Record<string, unknown> = {
		title: caption,
		privacy_level: privacyLevel,
		disable_comment: !allowComment,
	};

	// Optional video settings
	if (opts.allow_duet !== undefined) {
		postInfo.disable_duet = !(opts.allow_duet as boolean);
	}
	if (opts.allow_stitch !== undefined) {
		postInfo.disable_stitch = !(opts.allow_stitch as boolean);
	}
	if (opts.video_cover_timestamp_ms !== undefined) {
		postInfo.video_cover_timestamp_ms = opts.video_cover_timestamp_ms as number;
	}
	if (opts.video_made_with_ai !== undefined) {
		postInfo.is_aigc = opts.video_made_with_ai as boolean;
	}
	if (opts.brand_content_toggle !== undefined) {
		postInfo.brand_content_toggle = opts.brand_content_toggle as boolean;
	}
	if (opts.brand_organic_toggle !== undefined) {
		postInfo.brand_organic_toggle = opts.brand_organic_toggle as boolean;
	}

	const body = {
		post_info: postInfo,
		source_info: {
			source: "PULL_FROM_URL",
			video_url: videoUrl,
		},
	};

	// TikTok Content Posting API — Initialize video publish
	// https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
	const res = await tiktokFetch(
		`${TIKTOK_API}/post/publish/video/init/`,
		accessToken,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new Error(`TikTok video init failed: ${detail}`);
	}

	const initResult = (await res.json()) as TikTokPublishResponse;

	if (initResult.error?.code && initResult.error.code !== "ok") {
		// Classify TikTok-specific error codes
		const errCode = initResult.error.code;
		if (errCode === "access_token_invalid" || errCode === "token_expired") {
			throw new Error(`TOKEN_EXPIRED: ${initResult.error.message ?? "TikTok token invalid"}`);
		}
		if (errCode === "rate_limit_exceeded" || errCode === "spam_risk_too_many_posts") {
			return {
				success: false,
				error: { code: "RATE_LIMITED", message: initResult.error.message ?? "TikTok rate limit exceeded" },
			};
		}
		return {
			success: false,
			error: {
				code: errCode,
				message: initResult.error.message ?? "TikTok video init failed.",
			},
		};
	}

	const publishId = initResult.data?.publish_id;
	if (!publishId) {
		return {
			success: false,
			error: {
				code: "MISSING_PUBLISH_ID",
				message: "TikTok did not return a publish_id.",
			},
		};
	}

	// Poll for completion
	const status = await pollPublishStatus(accessToken, publishId);

	if (status.error?.code && status.error.code !== "ok") {
		return {
			success: false,
			error: {
				code: status.error.code,
				message: status.error.message ?? "TikTok publish failed.",
			},
		};
	}

	if (status.data?.status === "FAILED") {
		return {
			success: false,
			error: {
				code: "TIKTOK_PUBLISH_FAILED",
				message: status.data.fail_reason ?? "TikTok publish failed.",
			},
		};
	}

	// SEND_TO_USER_INBOX means content was sent to user's TikTok inbox for review
	if (status.data?.status === "SEND_TO_USER_INBOX") {
		return {
			success: true,
			platform_post_id: publishId,
			platform_url: "https://www.tiktok.com/messages?lang=en",
		};
	}

	const postIds = status.data?.publicaly_available_post_id;
	const postId = postIds?.[0];

	return {
		success: true,
		platform_post_id: postId ?? publishId,
		platform_url: undefined,
	};
}

async function publishPhotos(
	accessToken: string,
	photoUrls: string[],
	content: string,
	opts: Record<string, unknown>,
	privacyLevel: string,
	allowComment: boolean,
): Promise<PublishResult> {
	// Photo size limit: 20MB per image (validated server-side for PULL_FROM_URL)
	// Docs: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide

	// Photo title: max 90 chars
	const title = content.slice(0, 90);

	// Description for photo carousels
	const description = (opts.description as string | undefined) ?? content;
	if (description.length > 4000) {
		return {
			success: false,
			error: {
				code: "CONTENT_TOO_LONG",
				message: `Photo description is ${description.length} characters. TikTok limit is 4,000.`,
			},
		};
	}

	const postInfo: Record<string, unknown> = {
		title,
		description,
		privacy_level: privacyLevel,
		disable_comment: !allowComment,
	};

	if (opts.auto_add_music !== undefined) {
		postInfo.auto_add_music = opts.auto_add_music as boolean;
	}
	// brand_content_toggle and brand_organic_toggle are optional for DIRECT_POST photo posts
	// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
	postInfo.brand_content_toggle = (opts.brand_content_toggle as boolean) ?? false;
	postInfo.brand_organic_toggle = (opts.brand_organic_toggle as boolean) ?? false;

	// photo_cover_index belongs in source_info, not post_info
	const sourceInfo: Record<string, unknown> = {
		source: "PULL_FROM_URL",
		photo_images: photoUrls,
		photo_cover_index: (opts.photo_cover_index as number) ?? 0,
	};

	const body = {
		post_info: postInfo,
		source_info: sourceInfo,
		post_mode: "DIRECT_POST",
		media_type: "PHOTO",
	};

	// TikTok Content Posting API — Initialize photo publish
	// https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
	const res = await tiktokFetch(
		`${TIKTOK_API}/post/publish/content/init/`,
		accessToken,
		{
			method: "POST",
			body: JSON.stringify(body),
		},
	);

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		const detail =
			(err as { error?: { message?: string } }).error?.message ??
			res.statusText;
		throw new Error(`TikTok photo init failed: ${detail}`);
	}

	const initResult = (await res.json()) as TikTokPublishResponse;

	if (initResult.error?.code && initResult.error.code !== "ok") {
		return {
			success: false,
			error: {
				code: initResult.error.code,
				message: initResult.error.message ?? "TikTok photo init failed.",
			},
		};
	}

	const publishId = initResult.data?.publish_id;
	if (!publishId) {
		return {
			success: false,
			error: {
				code: "MISSING_PUBLISH_ID",
				message: "TikTok did not return a publish_id.",
			},
		};
	}

	// Poll for completion
	const status = await pollPublishStatus(accessToken, publishId);

	if (status.error?.code && status.error.code !== "ok") {
		return {
			success: false,
			error: {
				code: status.error.code,
				message: status.error.message ?? "TikTok publish failed.",
			},
		};
	}

	if (status.data?.status === "FAILED") {
		return {
			success: false,
			error: {
				code: "TIKTOK_PUBLISH_FAILED",
				message: status.data.fail_reason ?? "TikTok publish failed.",
			},
		};
	}

	// SEND_TO_USER_INBOX means content was sent to user's TikTok inbox for review
	if (status.data?.status === "SEND_TO_USER_INBOX") {
		return {
			success: true,
			platform_post_id: publishId,
			platform_url: "https://www.tiktok.com/messages?lang=en",
		};
	}

	const postIds = status.data?.publicaly_available_post_id;
	const postId = postIds?.[0];

	return {
		success: true,
		platform_post_id: postId ?? publishId,
		platform_url: undefined,
	};
}
