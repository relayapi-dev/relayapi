import { API_VERSIONS } from "../config/api-versions";
import {
	ensureResponseContentLength,
	fetchPublicUrl,
	getChunkedResponseBody,
	parseContentLength,
} from "../lib/fetch-public-url";
import {
	classifyPublishError,
	type EngagementAccount,
	type EngagementActionResult,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const TWITTER_API = `https://api.x.com/${API_VERSIONS.twitter}`;
const TWITTER_UPLOAD_BASE = `${TWITTER_API}/media/upload`;

interface TwitterAuth {
	access_token: string;
}

interface TwitterPoll {
	options: string[];
	duration_minutes: number;
}

type TwitterMedia = { url: string; type?: string };

function validateTwitterMedia(media: TwitterMedia[]): void {
	if (media.length === 0) return;
	// Official docs: https://docs.x.com/x-api/media/quickstart/best-practices
	// Section "Media combinations" -> up to four photos, or exactly one
	// animated GIF, or exactly one video can be attached to a Post.
	const allImages = media.every(
		(item) => item.type === undefined || item.type === "image",
	);
	if (allImages && media.length <= 4) return;
	if (
		media.length === 1 &&
		(media[0]?.type === "video" || media[0]?.type === "gif")
	) {
		return;
	}
	throw new Error(
		"CONTENT_ERROR: X supports up to four images, or one GIF, or one video per Post; those media types cannot be mixed.",
	);
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
	const taggedUsers = extraParams?.tagged_user_ids as string[] | undefined;
	if (
		taggedUsers &&
		taggedUsers.length > 0 &&
		(!mediaIds || mediaIds.length === 0)
	) {
		throw new Error(
			"CONTENT_ERROR: X tagged_user_ids require at least one media attachment.",
		);
	}
	if (taggedUsers && taggedUsers.length > 10) {
		// Official docs: https://docs.x.com/x-api/posts/create-or-edit-post
		// Section "media.tagged_user_ids" -> optional array with max length 10.
		throw new Error(
			"CONTENT_ERROR: X supports at most 10 tagged users on attached media.",
		);
	}

	if (mediaIds && mediaIds.length > 0) {
		const mediaBody: Record<string, unknown> = { media_ids: mediaIds };
		if (taggedUsers && taggedUsers.length > 0) {
			mediaBody.tagged_user_ids = taggedUsers;
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
			// `tagged_user_ids` is valid only inside the media object above.
			if (key !== "tagged_user_ids" && value !== undefined) {
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
		const detail =
			(err as { detail?: string }).detail ??
			(err as { message?: string }).message ??
			(err as { errors?: Array<{ message?: string }> }).errors?.[0]?.message ??
			res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		if (
			res.status === 401 ||
			detail.includes("Unsupported Authentication") ||
			detail.includes("unauthorized")
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (
			res.status === 429 ||
			detail.includes("usage-capped") ||
			detail.includes("Rate limit")
		) {
			const resetHeader = res.headers.get("x-rate-limit-reset")?.trim();
			const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : Number.NaN;
			throw new PublishError(`RATE_LIMITED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
				retryAfterMs:
					Number.isFinite(resetAtMs) && resetAtMs > Date.now()
						? resetAtMs - Date.now()
						: undefined,
			});
		}
		if (res.status === 403) {
			throw new PublishError(`CONTENT_ERROR: Forbidden — ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (res.status >= 500) {
			throw new PublishError(`PLATFORM_ERROR: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		throw new PublishError(`Twitter tweet creation failed: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
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
	let mediaRes = await fetchPublicUrl(mediaUrl, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new PublishError(
			`Failed to fetch media from ${mediaUrl}: ${mediaRes.statusText}`,
			{
				statusCode: mediaRes.status,
				detail: `HTTP ${mediaRes.status} ${mediaRes.statusText}`,
			},
		);
	}
	// Validate size limits per X API docs
	const mimeType =
		mediaRes.headers.get("content-type") ?? guessMimeType(mediaType);
	const maxBytes = mimeType.startsWith("video/")
		? 512 * 1024 * 1024 // 512 MB for video
		: mimeType === "image/gif"
			? 15 * 1024 * 1024 // 15 MB for GIF
			: 5 * 1024 * 1024; // 5 MB for images
	const chunkSize = 5 * 1024 * 1024;
	mediaRes = await ensureResponseContentLength(mediaRes, maxBytes, () =>
		fetchPublicUrl(mediaUrl, { timeout: 30_000, maxBytes }),
	);
	const totalBytes = parseContentLength(mediaRes.headers) as number;

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
		void mediaRes.body?.cancel().catch(() => {});
		const err = await initRes.json().catch(() => ({}));
		const detail =
			(err as { detail?: string }).detail ??
			(err as { message?: string }).message ??
			(err as { errors?: Array<{ message?: string }> }).errors?.[0]?.message ??
			initRes.statusText;
		const raw = `HTTP ${initRes.status}\n${JSON.stringify(err)}`;
		if (initRes.status === 401)
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: initRes.status,
				detail: raw,
			});
		if (initRes.status === 429)
			throw new PublishError(`RATE_LIMITED: ${detail}`, {
				statusCode: initRes.status,
				detail: raw,
			});
		throw new PublishError(`Twitter media INIT failed: ${detail}`, {
			statusCode: initRes.status,
			detail: raw,
		});
	}
	const initData = (await initRes.json()) as {
		data: { id: string; media_key: string };
	};
	const mediaId = initData.data.id;
	const source = getChunkedResponseBody(mediaRes, maxBytes, chunkSize);

	// APPEND — upload in 5MB chunks using dedicated endpoint
	let segmentIndex = 0;

	for await (const chunk of source.chunks) {
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
			const detail =
				(err as { detail?: string }).detail ??
				(err as { message?: string }).message ??
				(err as { errors?: Array<{ message?: string }> }).errors?.[0]
					?.message ??
				appendRes.statusText;
			const raw = `HTTP ${appendRes.status}\n${JSON.stringify(err)}`;
			throw new PublishError(
				`Twitter media APPEND failed at segment ${segmentIndex}: ${detail}`,
				{ statusCode: appendRes.status, detail: raw },
			);
		}

		segmentIndex++;
	}

	// X API v2: Finalize media upload (dedicated endpoint)
	// Docs: https://docs.x.com/x-api/media/finalize-media-upload
	const finalizeRes = await fetch(
		`${TWITTER_UPLOAD_BASE}/${mediaId}/finalize`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
			},
		},
	);
	if (!finalizeRes.ok) {
		const err = await finalizeRes.json().catch(() => ({}));
		const detail =
			(err as { detail?: string }).detail ??
			(err as { message?: string }).message ??
			(err as { errors?: Array<{ message?: string }> }).errors?.[0]?.message ??
			finalizeRes.statusText;
		const raw = `HTTP ${finalizeRes.status}\n${JSON.stringify(err)}`;
		throw new PublishError(`Twitter media FINALIZE failed: ${detail}`, {
			statusCode: finalizeRes.status,
			detail: raw,
		});
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
		// Section "Step 4: Check status (STATUS)" documents:
		// GET https://api.x.com/2/media/upload?command=STATUS&media_id={media_id}
		const res = await fetch(getTwitterMediaStatusUrl(mediaId), {
			headers: { Authorization: `Bearer ${auth.access_token}` },
		});

		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			const detail =
				(err as { detail?: string }).detail ??
				(err as { message?: string }).message ??
				(err as { errors?: Array<{ message?: string }> }).errors?.[0]
					?.message ??
				res.statusText;
			const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
			throw new PublishError(`Twitter media STATUS check failed: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
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

export function getTwitterMediaStatusUrl(mediaId: string): URL {
	const statusUrl = new URL(TWITTER_UPLOAD_BASE);
	statusUrl.searchParams.set("command", "STATUS");
	statusUrl.searchParams.set("media_id", mediaId);
	return statusUrl;
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

	async repost(
		account: EngagementAccount,
		platformPostId: string,
	): Promise<EngagementActionResult> {
		try {
			const auth: TwitterAuth = { access_token: account.access_token };
			// X API v2: Retweet a tweet
			// https://docs.x.com/x-api/posts/repost-a-post
			const res = await twitterFetch(
				`${TWITTER_API}/users/${account.platform_account_id}/retweets`,
				auth,
				{
					method: "POST",
					body: JSON.stringify({ tweet_id: platformPostId }),
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail =
					(err as { detail?: string }).detail ??
					(err as { message?: string }).message ??
					(err as { errors?: Array<{ message?: string }> }).errors?.[0]
						?.message ??
					res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				if (res.status === 401)
					throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				if (res.status === 429)
					throw new PublishError(`RATE_LIMITED: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				throw new PublishError(`Twitter retweet failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}
			return { success: true, platform_post_id: platformPostId };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async comment(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult> {
		try {
			const auth: TwitterAuth = { access_token: account.access_token };
			const result = await createTweet(auth, text, undefined, platformPostId);
			return { success: true, platform_post_id: result.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async quote(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult> {
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
				const detail =
					(err as { detail?: string }).detail ??
					(err as { message?: string }).message ??
					(err as { errors?: Array<{ message?: string }> }).errors?.[0]
						?.message ??
					res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				if (res.status === 401)
					throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				if (res.status === 429)
					throw new PublishError(`RATE_LIMITED: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				throw new PublishError(`Twitter quote tweet failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}
			const result = (await res.json()) as { data: { id: string } };
			return { success: true, platform_post_id: result.data.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		let threadHasPublished = false;
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
					() => {
						threadHasPublished = true;
					},
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

				const twitterMedia = opts.media as
					| Array<{ url: string; type?: string }>
					| undefined;
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
				validateTwitterMedia(media);
				mediaIds = await Promise.all(
					media.map((m) =>
						uploadMedia(
							auth,
							m.url,
							m.type ?? "image",
							(m as { alt_text?: string }).alt_text,
						),
					),
				);
			}

			const replyTo = opts.reply_to as string | undefined;
			const replySettings = opts.reply_settings as
				| "following"
				| "mentionedUsers"
				| "subscribers"
				| "verified"
				| undefined;
			const validatedPoll = poll
				? {
						options: poll.options as string[],
						duration_minutes: poll.duration_minutes as number,
					}
				: undefined;

			const extraParams: Record<string, unknown> = {};
			if (opts.made_with_ai !== undefined)
				extraParams.made_with_ai = opts.made_with_ai;
			if (opts.paid_partnership !== undefined)
				extraParams.paid_partnership = opts.paid_partnership;
			if (opts.community_id) extraParams.community_id = opts.community_id;
			if (opts.share_with_followers !== undefined)
				extraParams.share_with_followers = opts.share_with_followers;
			if (opts.tagged_user_ids)
				extraParams.tagged_user_ids = opts.tagged_user_ids;

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
			const threadItems = request.target_options.thread;
			const isThread = Array.isArray(threadItems) && threadItems.length > 0;
			return classifyPublishError(err, {
				safeToRetryRateLimit: !isThread || !threadHasPublished,
				definitiveHttpRejection: isThread && !threadHasPublished,
			});
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
	onFirstPublished?: () => void,
): Promise<PublishResult> {
	let firstTweetId: string | undefined;
	let parentId: string | undefined = replyToId;

	for (const [i, item] of items.entries()) {
		let mediaIds: string[] | undefined;
		if (item.media && item.media.length > 0) {
			validateTwitterMedia(item.media);
			mediaIds = await Promise.all(
				item.media.map((m) =>
					uploadMedia(
						auth,
						m.url,
						m.type ?? "image",
						(m as { alt_text?: string }).alt_text,
					),
				),
			);
		}

		const result = await createTweet(auth, item.content, mediaIds, parentId);

		if (i === 0) {
			firstTweetId = result.id;
			onFirstPublished?.();
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
