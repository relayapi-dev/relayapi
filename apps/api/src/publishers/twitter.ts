import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type EngagementAccount, type EngagementActionResult, type Publisher, type PublishRequest, type PublishResult } from "./types";

const TWITTER_API = "https://api.x.com/2";
const TWITTER_UPLOAD_BASE = "https://api.x.com/2/media/upload";

interface TwitterAuth {
	access_token: string;
}

interface TwitterPoll {
	options: string[];
	duration_minutes: number;
}

async function twitterFetch(
	url: string,
	auth: TwitterAuth,
	options: RequestInit = {},
): Promise<Response> {
	return fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
}

async function createTweet(
	auth: TwitterAuth,
	text: string,
	mediaIds?: string[],
	replyToId?: string,
	poll?: TwitterPoll,
	replySettings?: "following" | "mentionedUsers" | "subscribers" | "verified",
	extraParams?: Record<string, unknown>,
): Promise<{ id: string }> {
	const body: Record<string, unknown> = { text };

	if (mediaIds && mediaIds.length > 0) {
		const mediaBody: Record<string, unknown> = { media_ids: mediaIds };
		const taggedUsers = extraParams?.tagged_user_ids as string[] | undefined;
		if (taggedUsers && taggedUsers.length > 0) {
			mediaBody.tagged_user_ids = taggedUsers.slice(0, 10);
		}
		body.media = mediaBody;
	}

	if (replyToId) {
		body.reply = { in_reply_to_tweet_id: replyToId };
	}

	if (poll) {
		body.poll = {
			options: poll.options,
			duration_minutes: poll.duration_minutes,
		};
	}

	// X API v2: reply_settings — controls who can reply to the tweet
	// Docs: https://docs.x.com/x-api/posts/creation-of-a-post
	// Section: "TweetCreateRequest" — reply_settings is a top-level string field
	// Valid values: "following", "mentionedUsers", "subscribers", "verified"
	if (replySettings) {
		body.reply_settings = replySettings;
	}

	if (extraParams) {
		for (const [key, value] of Object.entries(extraParams)) {
			if (value !== undefined) {
				body[key] = value;
			}
		}
	}

	// X API v2: Create Tweet
	// Docs: https://docs.x.com/x-api/posts/creation-of-a-post
	// Section: "POST /2/tweets" — creates a tweet with optional media, poll, reply, reply_settings
	const res = await twitterFetch(`${TWITTER_API}/tweets`, auth, {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		const detail = (err as { detail?: string }).detail
			?? (err as { message?: string }).message
			?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
			?? res.statusText;
		if (res.status === 401 || detail.includes("Unsupported Authentication") || detail.includes("unauthorized")) {
			throw new Error(`TOKEN_EXPIRED: ${detail}`);
		}
		if (res.status === 429 || detail.includes("usage-capped") || detail.includes("Rate limit")) {
			throw new Error(`RATE_LIMITED: ${detail}`);
		}
		if (res.status === 403) {
			throw new Error(`CONTENT_ERROR: Forbidden — ${detail}`);
		}
		if (res.status >= 500) {
			throw new Error(`PLATFORM_ERROR: ${detail}`);
		}
		throw new Error(`Twitter tweet creation failed: ${detail}`);
	}

	const result = (await res.json()) as { data: { id: string } };
	return { id: result.data.id };
}

/**
 * Upload media to X using the v2 chunked upload API.
 * Flow: INIT → APPEND (chunks) → FINALIZE → (poll STATUS for videos)
 */
async function uploadMedia(
	auth: TwitterAuth,
	mediaUrl: string,
	mediaType: string,
	altText?: string,
): Promise<string> {
	// Fetch the media file
	const mediaRes = await fetchPublicUrl(mediaUrl, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new Error(
			`Failed to fetch media from ${mediaUrl}: ${mediaRes.statusText}`,
		);
	}
	const mediaBytes = await mediaRes.arrayBuffer();
	const totalBytes = mediaBytes.byteLength;

	// Validate size limits per X API docs
	const mimeFromHeader = mediaRes.headers.get("content-type") ?? "";
	const maxBytes = mimeFromHeader.startsWith("video/")
		? 512 * 1024 * 1024  // 512 MB for video
		: mimeFromHeader === "image/gif"
			? 15 * 1024 * 1024  // 15 MB for GIF
			: 5 * 1024 * 1024;  // 5 MB for images
	if (totalBytes > maxBytes) {
		throw new Error(
			`CONTENT_ERROR: Media file too large (${(totalBytes / 1024 / 1024).toFixed(1)}MB). X allows max ${(maxBytes / 1024 / 1024).toFixed(0)}MB for ${mimeFromHeader || mediaType}.`,
		);
	}

	// Determine MIME type
	const mimeType =
		mediaRes.headers.get("content-type") ?? guessMimeType(mediaType);

	// Determine media_category (required for video/GIF async processing)
	const mediaCategory = mimeType.startsWith("video/")
		? "tweet_video"
		: mimeType === "image/gif"
			? "tweet_gif"
			: "tweet_image";

	// X API v2: Initialize media upload (dedicated endpoint)
	// Docs: https://docs.x.com/x-api/media/initialize-media-upload
	const initRes = await fetch(`${TWITTER_UPLOAD_BASE}/initialize`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			media_type: mimeType,
			total_bytes: totalBytes,
			media_category: mediaCategory,
		}),
	});
	if (!initRes.ok) {
		const err = await initRes.json().catch(() => ({}));
		const detail = (err as { detail?: string }).detail
			?? (err as { message?: string }).message
			?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
			?? initRes.statusText;
		if (initRes.status === 401) throw new Error(`TOKEN_EXPIRED: ${detail}`);
		if (initRes.status === 429) throw new Error(`RATE_LIMITED: ${detail}`);
		throw new Error(`Twitter media INIT failed: ${detail}`);
	}
	const initData = (await initRes.json()) as {
		data: { id: string; media_key: string };
	};
	const mediaId = initData.data.id;

	// APPEND — upload in 5MB chunks using dedicated endpoint
	const chunkSize = 5 * 1024 * 1024;
	let segmentIndex = 0;
	let offset = 0;

	while (offset < totalBytes) {
		const end = Math.min(offset + chunkSize, totalBytes);
		const chunk = mediaBytes.slice(offset, end);

		const formData = new FormData();
		formData.append("segment_index", segmentIndex.toString());
		// Use Blob for binary upload — avoids btoa crash on large buffers
		formData.append("media", new Blob([chunk]));

		// X API v2: Append media upload (dedicated endpoint)
		// Docs: https://docs.x.com/x-api/media/append-media-upload
		const appendRes = await fetch(`${TWITTER_UPLOAD_BASE}/${mediaId}/append`, {
			method: "POST",
			headers: { Authorization: `Bearer ${auth.access_token}` },
			body: formData,
		});
		if (!appendRes.ok) {
			const err = await appendRes.json().catch(() => ({}));
			const detail = (err as { detail?: string }).detail
				?? (err as { message?: string }).message
				?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
				?? appendRes.statusText;
			throw new Error(
				`Twitter media APPEND failed at segment ${segmentIndex}: ${detail}`,
			);
		}

		offset = end;
		segmentIndex++;
	}

	// X API v2: Finalize media upload (dedicated endpoint)
	// Docs: https://docs.x.com/x-api/media/finalize-media-upload
	const finalizeRes = await fetch(`${TWITTER_UPLOAD_BASE}/${mediaId}/finalize`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
		},
	});
	if (!finalizeRes.ok) {
		const err = await finalizeRes.json().catch(() => ({}));
		const detail = (err as { detail?: string }).detail
			?? (err as { message?: string }).message
			?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
			?? finalizeRes.statusText;
		throw new Error(`Twitter media FINALIZE failed: ${detail}`);
	}

	const finalizeData = (await finalizeRes.json()) as {
		data: {
			id: string;
			processing_info?: { state: string; check_after_secs?: number };
		};
	};

	// Poll STATUS for async processing (videos)
	if (finalizeData.data.processing_info) {
		await pollMediaStatus(
			auth,
			mediaId,
			finalizeData.data.processing_info.check_after_secs ?? 5,
		);
	}

	// X API v2: Set media metadata (alt text)
	// Docs: https://docs.x.com/x-api/media/create-media-metadata
	if (altText) {
		await twitterFetch(`${TWITTER_API}/media/metadata`, auth, {
			method: "POST",
			body: JSON.stringify({
				id: mediaId,
				metadata: { alt_text: { text: altText.slice(0, 1000) } },
			}),
		});
	}

	return mediaId;
}

async function pollMediaStatus(
	auth: TwitterAuth,
	mediaId: string,
	initialWait: number,
): Promise<void> {
	let wait = initialWait;
	const maxAttempts = 30;

	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, wait * 1000));

		// X API v2: Media Upload STATUS
		// Docs: https://docs.x.com/x-api/media/quickstart/media-upload-chunked
		const res = await fetch(
			`${TWITTER_UPLOAD_BASE}/${mediaId}`,
			{
				headers: { Authorization: `Bearer ${auth.access_token}` },
			},
		);

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			const detail = (err as { detail?: string }).detail
				?? (err as { message?: string }).message
				?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
				?? res.statusText;
			throw new Error(`Twitter media STATUS check failed: ${detail}`);
		}

		// v2 response wraps under { data: { processing_info } }
		const response = (await res.json()) as {
			data: {
				processing_info?: {
					state: string;
					check_after_secs?: number;
					error?: { message: string };
				};
			};
		};
		const info = response.data?.processing_info;

		if (!info || info.state === "succeeded") {
			return;
		}

		if (info.state === "failed") {
			throw new Error(
				`Twitter media processing failed: ${info.error?.message ?? "unknown"}`,
			);
		}

		wait = info.check_after_secs ?? 5;
	}

	throw new Error("Twitter media processing timed out");
}

function guessMimeType(type: string): string {
	switch (type) {
		case "image":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "video":
			return "video/mp4";
		default:
			return "application/octet-stream";
	}
}

export const twitterPublisher: Publisher = {
	platform: "twitter",

	async repost(account: EngagementAccount, platformPostId: string): Promise<EngagementActionResult> {
		try {
			const auth: TwitterAuth = { access_token: account.access_token };
			// X API v2: Retweet a tweet
			// https://docs.x.com/x-api/posts/repost-a-post
			const res = await twitterFetch(`${TWITTER_API}/users/${account.platform_account_id}/retweets`, auth, {
				method: "POST",
				body: JSON.stringify({ tweet_id: platformPostId }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as { detail?: string }).detail
					?? (err as { message?: string }).message
					?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
					?? res.statusText;
				if (res.status === 401) throw new Error(`TOKEN_EXPIRED: ${detail}`);
				if (res.status === 429) throw new Error(`RATE_LIMITED: ${detail}`);
				throw new Error(`Twitter retweet failed: ${detail}`);
			}
			return { success: true, platform_post_id: platformPostId };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async comment(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const auth: TwitterAuth = { access_token: account.access_token };
			const result = await createTweet(auth, text, undefined, platformPostId);
			return { success: true, platform_post_id: result.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async quote(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const auth: TwitterAuth = { access_token: account.access_token };
			// X API v2: Quote tweet
			// https://docs.x.com/x-api/posts/create-post
			const res = await twitterFetch(`${TWITTER_API}/tweets`, auth, {
				method: "POST",
				body: JSON.stringify({ text, quote_tweet_id: platformPostId }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as { detail?: string }).detail
					?? (err as { message?: string }).message
					?? (err as { errors?: Array<{message?: string}> }).errors?.[0]?.message
					?? res.statusText;
				if (res.status === 401) throw new Error(`TOKEN_EXPIRED: ${detail}`);
				if (res.status === 429) throw new Error(`RATE_LIMITED: ${detail}`);
				throw new Error(`Twitter quote tweet failed: ${detail}`);
			}
			const result = (await res.json()) as { data: { id: string } };
			return { success: true, platform_post_id: result.data.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const auth: TwitterAuth = { access_token: request.account.access_token };
			const opts = request.target_options;

			// Check for thread
			const threadItems = opts.thread as
				| Array<{
						content: string;
						media?: Array<{ url: string; type?: string }>;
				  }>
				| undefined;

			if (threadItems && threadItems.length > 0) {
				if (opts.poll) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message: "Polls cannot be combined with threads.",
						},
					};
				}
				return await publishThread(
					auth,
					threadItems,
					request.account.username,
					opts.reply_to as string | undefined,
				);
			}

			// Validate poll if present
			const poll = opts.poll as
				| { options?: unknown; duration_minutes?: unknown }
				| undefined;

			if (poll) {
				const options = poll.options;
				if (
					!Array.isArray(options) ||
					options.length < 2 ||
					options.length > 4
				) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message: "Poll must have 2 to 4 options.",
						},
					};
				}

				for (const [i, option] of options.entries()) {
					if (
						typeof option !== "string" ||
						option.length < 1 ||
						option.length > 25
					) {
						return {
							success: false,
							error: {
								code: "INVALID_POLL",
								message: `Poll option ${i + 1} must be a string of 1 to 25 characters.`,
							},
						};
					}
				}

				const duration = poll.duration_minutes;
				if (
					typeof duration !== "number" ||
					!Number.isInteger(duration) ||
					duration < 5 ||
					duration > 10080
				) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message:
								"Poll duration_minutes must be an integer between 5 and 10080.",
						},
					};
				}

				const twitterMedia = opts.media as Array<{ url: string; type?: string }> | undefined;
				const topLevelMedia = request.media;
				if (
					(twitterMedia && twitterMedia.length > 0) ||
					(topLevelMedia && topLevelMedia.length > 0)
				) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message: "Polls cannot be combined with media attachments.",
						},
					};
				}
			}

			// Single tweet
			const content = (opts.content as string) ?? request.content ?? "";

			// Upload media if present
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			let mediaIds: string[] | undefined;

			if (media && media.length > 0) {
				mediaIds = await Promise.all(
					media.map((m) => uploadMedia(auth, m.url, m.type ?? "image", (m as any).alt_text)),
				);
			}

			const replyTo = opts.reply_to as string | undefined;
			const replySettings = opts.reply_settings as
				| "following" | "mentionedUsers" | "subscribers" | "verified"
				| undefined;
			const validatedPoll = poll
				? {
						options: poll.options as string[],
						duration_minutes: poll.duration_minutes as number,
					}
				: undefined;

			const extraParams: Record<string, unknown> = {};
			if (opts.made_with_ai !== undefined) extraParams.made_with_ai = opts.made_with_ai;
			if (opts.paid_partnership !== undefined) extraParams.paid_partnership = opts.paid_partnership;
			if (opts.community_id) extraParams.community_id = opts.community_id;
			if (opts.share_with_followers !== undefined) extraParams.share_with_followers = opts.share_with_followers;
			if (opts.tagged_user_ids) extraParams.tagged_user_ids = opts.tagged_user_ids;

			const result = await createTweet(
				auth,
				content,
				mediaIds,
				replyTo,
				validatedPoll,
				replySettings,
				Object.keys(extraParams).length > 0 ? extraParams : undefined,
			);
			const username =
				request.account.username ?? request.account.platform_account_id;
			const tweetUrl = `https://x.com/${username}/status/${result.id}`;

			return {
				success: true,
				platform_post_id: result.id,
				platform_url: tweetUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};

async function publishThread(
	auth: TwitterAuth,
	items: Array<{
		content: string;
		media?: Array<{ url: string; type?: string }>;
	}>,
	username: string | null,
	replyToId?: string,
): Promise<PublishResult> {
	let firstTweetId: string | undefined;
	let parentId: string | undefined = replyToId;

	for (const [i, item] of items.entries()) {
		let mediaIds: string[] | undefined;
		if (item.media && item.media.length > 0) {
			mediaIds = await Promise.all(
				item.media.map((m) => uploadMedia(auth, m.url, m.type ?? "image", (m as any).alt_text)),
			);
		}

		const result = await createTweet(auth, item.content, mediaIds, parentId);

		if (i === 0) {
			firstTweetId = result.id;
		}
		parentId = result.id;
	}

	const handle = username ?? "i";
	const tweetUrl = `https://x.com/${handle}/status/${firstTweetId}`;

	return {
		success: true,
		platform_post_id: firstTweetId,
		platform_url: tweetUrl,
	};
}
