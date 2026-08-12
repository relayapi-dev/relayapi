import { GRAPH_BASE } from "../config/api-versions";
import { ThreadsTargetOptions } from "../schemas/publisher-options";
import { readPublisherJson } from "./provider-response";
import {
	classifyPublishError,
	type EngagementAccount,
	type EngagementActionResult,
	getSucceededProviderEffect,
	mergeProviderEffects,
	type ProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	recordProviderEffect,
} from "./types";

const GRAPH_API = GRAPH_BASE.threads;

interface ThreadsAuth {
	access_token: string;
	user_id: string;
}

const THREADS_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});
const THREADS_EMOJI_GRAPHEME =
	/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u;

export function countThreadsCharacters(text: string): number {
	// Official docs: https://developers.facebook.com/docs/threads/posts
	// Section "Single Thread Posts" > "Limitations": text posts are limited to
	// 500 characters, and "Emojis are counted as the number of UTF-8 bytes."
	// Charge ordinary graphemes once, but charge a complete emoji grapheme by its
	// encoded byte length so joined, modified, keycap, and flag emoji stay intact.
	const encoder = new TextEncoder();
	let count = 0;
	for (const { segment } of THREADS_GRAPHEME_SEGMENTER.segment(text)) {
		count += THREADS_EMOJI_GRAPHEME.test(segment)
			? encoder.encode(segment).byteLength
			: 1;
	}
	return count;
}

async function graphPost(
	endpoint: string,
	auth: ThreadsAuth,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const url = `${GRAPH_API}${endpoint}`;
	// Threads API: POST request to Threads Graph API
	// Official docs show form-encoded parameters (not JSON) for all POST requests
	// Docs: https://developers.facebook.com/docs/threads/posts
	const params = new URLSearchParams();
	params.set("access_token", auth.access_token);
	for (const [key, value] of Object.entries(body)) {
		if (value !== undefined && value !== null) {
			params.set(key, String(value));
		}
	}
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});

	if (!res.ok) {
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: { message?: string; code?: number; error_subcode?: number };
		};
		const detail = err.error?.message ?? res.statusText;
		const errCode = err.error?.code;
		const errSubcode = err.error?.error_subcode;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		// Detect token expiration
		// Docs: https://developers.facebook.com/docs/threads/troubleshooting
		if (
			errCode === 190 ||
			detail.includes("Error validating access token") ||
			detail.includes("session has been invalidated")
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (errSubcode === 4 || res.status === 429) {
			throw new PublishError(`RATE_LIMITED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		throw new PublishError(`Threads API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	return readPublisherJson(res) as Promise<Record<string, unknown>>;
}

async function graphGet(
	endpoint: string,
	auth: ThreadsAuth,
	params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
	const searchParams = new URLSearchParams({
		access_token: auth.access_token,
		...params,
	});
	const url = `${GRAPH_API}${endpoint}?${searchParams.toString()}`;
	// Threads API: GET request to Threads Graph API
	// Docs: https://developers.facebook.com/docs/threads/posts
	const res = await fetch(url);

	if (!res.ok) {
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(`Threads API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	return readPublisherJson(res) as Promise<Record<string, unknown>>;
}

/**
 * Create a Threads media container.
 */
async function createContainer(
	auth: ThreadsAuth,
	params: Record<string, unknown>,
): Promise<string> {
	// Threads API: Create a media container (step 1 of publishing)
	// Docs: https://developers.facebook.com/docs/threads/posts
	const result = await graphPost(`/${auth.user_id}/threads`, auth, params);
	return result.id as string;
}

/**
 * Poll container status until ready for publishing.
 */
async function pollContainerStatus(
	auth: ThreadsAuth,
	containerId: string,
	maxAttempts = 5,
	intervalMs = 60000,
): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		// Threads API: Check media container processing status
		// Request error_message to get detailed failure reasons
		// Docs: https://developers.facebook.com/docs/threads/troubleshooting
		const result = await graphGet(`/${containerId}`, auth, {
			fields: "status,error_message",
		});

		const status = result.status as string;

		if (status === "FINISHED") {
			return;
		}

		if (status === "ERROR") {
			const errorMessage = result.error_message as string | undefined;
			throw new Error(
				`Threads media container processing failed: ${errorMessage ?? "unknown error"}`,
			);
		}

		if (status === "EXPIRED") {
			throw new Error(
				"Threads media container expired before publishing (containers must be published within 24 hours).",
			);
		}

		// Back off: short initial waits, then longer (docs recommend once per minute)
		const delay = i < 2 ? 5000 : intervalMs;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	throw new Error("Threads media processing timed out");
}

/**
 * Publish a prepared container.
 */
async function publishContainer(
	auth: ThreadsAuth,
	containerId: string,
	onPublished?: (postId: string) => Promise<void>,
): Promise<{ id: string; permalink: string | null }> {
	// Threads API: Publish a media container (step 2 of publishing)
	// Docs: https://developers.facebook.com/docs/threads/posts#step-2--publish-a-threads-media-container
	const result = await graphPost(`/${auth.user_id}/threads_publish`, auth, {
		creation_id: containerId,
	});
	const postId = result.id as string;
	// Journal the visible post before any optional read-after-write request. A
	// Worker termination during permalink lookup must not make a retry publish the
	// same prepared container a second time.
	await onPublished?.(postId);

	// Fetch the actual permalink from the API after publish completes
	let permalink: string | null = null;
	try {
		const details = await graphGet(`/${postId}`, auth, {
			fields: "id,permalink",
		});
		permalink = (details.permalink as string) ?? null;
	} catch {
		// Non-fatal — permalink fetch can fail
	}

	return { id: postId, permalink };
}

/**
 * Create and publish a single Threads post (text, image, or video).
 */
async function publishSinglePost(
	auth: ThreadsAuth,
	text: string,
	media?: { url: string; type?: string; alt_text?: string },
	replyToId?: string,
	extraParams?: Record<string, unknown>,
	onPublished?: (postId: string) => Promise<void>,
): Promise<{ id: string; permalink: string | null }> {
	const params: Record<string, unknown> = {};

	if (media) {
		const isVideo = media.type === "video";
		params.media_type = isVideo ? "VIDEO" : "IMAGE";
		if (isVideo) {
			params.video_url = media.url;
		} else {
			params.image_url = media.url;
		}
		if (text) {
			params.text = text;
		}
		if (media.alt_text) {
			params.alt_text = media.alt_text;
		}
	} else {
		params.media_type = "TEXT";
		params.text = text;
	}

	if (replyToId) {
		params.reply_to_id = replyToId;
	}

	if (extraParams) {
		for (const [key, value] of Object.entries(extraParams)) {
			if (value !== undefined) params[key] = value;
		}
	}

	const containerId = await createContainer(auth, params);

	// Always poll for container processing (images and videos both need server-side processing)
	// Docs recommend waiting ~30 seconds before publishing for images
	await pollContainerStatus(auth, containerId);

	const published = await publishContainer(auth, containerId, onPublished);
	return published;
}

/**
 * Publish a carousel post with 2-20 items.
 */
async function publishCarousel(
	auth: ThreadsAuth,
	items: Array<{ url: string; type?: string; alt_text?: string }>,
	text?: string,
	replyToId?: string,
	extraParams?: Record<string, unknown>,
	onPublished?: (postId: string) => Promise<void>,
): Promise<{ id: string; permalink: string | null }> {
	// Threads carousels require 2-20 items
	if (items.length < 2) {
		throw new Error(
			"CONTENT_ERROR: Threads carousel requires at least 2 media items.",
		);
	}
	if (items.length > 20) {
		// Official Meta docs: https://developers.facebook.com/docs/threads/posts
		// Section "Carousel Posts" documents 2-20 children total.
		throw new Error(
			`CONTENT_ERROR: Threads carousels support at most 20 media items; received ${items.length}.`,
		);
	}

	// Create child containers
	const childIds: string[] = [];

	for (const item of items) {
		const isVideo = item.type === "video";
		const childParams: Record<string, unknown> = {
			media_type: isVideo ? "VIDEO" : "IMAGE",
			is_carousel_item: true,
		};

		if (isVideo) {
			childParams.video_url = item.url;
		} else {
			childParams.image_url = item.url;
		}
		if (item.alt_text) {
			childParams.alt_text = item.alt_text;
		}

		const childId = await createContainer(auth, childParams);
		childIds.push(childId);
	}

	// Poll all children in parallel (images and videos both need processing)
	await Promise.all(childIds.map((id) => pollContainerStatus(auth, id)));

	// Create parent carousel container
	const parentParams: Record<string, unknown> = {
		media_type: "CAROUSEL",
		children: childIds.join(","),
	};
	if (text) {
		parentParams.text = text;
	}
	if (replyToId) {
		parentParams.reply_to_id = replyToId;
	}

	if (extraParams) {
		for (const [key, value] of Object.entries(extraParams)) {
			if (value !== undefined) parentParams[key] = value;
		}
	}

	const parentId = await createContainer(auth, parentParams);

	// Poll parent container before publishing
	await pollContainerStatus(auth, parentId);

	return publishContainer(auth, parentId, onPublished);
}

/**
 * Publish a thread sequence: root post followed by sequential replies.
 */
async function publishThreadSequence(
	auth: ThreadsAuth,
	items: Array<{
		content: string;
		media?: Array<{ url: string; type?: string }>;
	}>,
	request?: Pick<PublishRequest, "effect_recorder">,
	rootExtraParams?: Record<string, unknown>,
	onPublished?: (postId: string, index: number) => Promise<void>,
): Promise<{ rootId: string; permalink: string | null }> {
	let rootId: string | undefined;
	let rootPermalink: string | null = null;
	let previousId: string | undefined;

	for (const [index, item] of items.entries()) {
		// Validate character limit per item
		const itemCharacters = countThreadsCharacters(item.content);
		if (itemCharacters > 500) {
			throw new Error(
				`CONTENT_ERROR: Thread item exceeds the 500-character limit (${itemCharacters} characters).`,
			);
		}

		const recorded = request
			? getSucceededProviderEffect(request, `thread_item_${index + 1}`)
			: undefined;
		if (recorded?.provider_id) {
			if (!rootId) rootId = recorded.provider_id;
			previousId = recorded.provider_id;
			continue;
		}

		let published: { id: string; permalink: string | null };

		if (item.media && item.media.length > 1) {
			// Carousel in thread
			published = await publishCarousel(
				auth,
				item.media,
				item.content || undefined,
				previousId,
				index === 0 ? rootExtraParams : undefined,
				async (postId) => {
					await onPublished?.(postId, index);
				},
			);
		} else if (item.media && item.media.length === 1) {
			// Single media in thread
			published = await publishSinglePost(
				auth,
				item.content,
				item.media[0],
				previousId,
				index === 0 ? rootExtraParams : undefined,
				async (postId) => {
					await onPublished?.(postId, index);
				},
			);
		} else {
			// Text-only in thread
			published = await publishSinglePost(
				auth,
				item.content,
				undefined,
				previousId,
				index === 0 ? rootExtraParams : undefined,
				async (postId) => {
					await onPublished?.(postId, index);
				},
			);
		}

		if (!rootId) {
			rootId = published.id;
			rootPermalink = published.permalink;
		}
		previousId = published.id;
	}

	return { rootId: rootId ?? "", permalink: rootPermalink };
}

export const threadsPublisher: Publisher = {
	platform: "threads",

	async comment(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult> {
		try {
			const auth: ThreadsAuth = {
				access_token: account.access_token,
				user_id: account.platform_account_id,
			};
			const result = await publishSinglePost(
				auth,
				text,
				undefined,
				platformPostId,
			);
			return { success: true, platform_post_id: result.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		let threadEffects: ProviderEffect[] = (
			request.effect_recorder?.effects ?? []
		)
			.filter(
				(effect) =>
					effect.name.startsWith("thread_item_") &&
					effect.status === "succeeded",
			)
			.slice();
		let threadHasPublished = threadEffects.length > 0;
		try {
			const parsedOptions = ThreadsTargetOptions.safeParse(
				request.target_options,
			);
			if (!parsedOptions.success) {
				const issue = parsedOptions.error.issues[0];
				const path = issue?.path.length ? ` ${issue.path.join(".")}` : "";
				return {
					success: false,
					error: {
						code: "INVALID_THREADS_TARGET_OPTIONS",
						message: `Invalid Threads target option${path}: ${issue?.message ?? "validation failed"}.`,
					},
				};
			}
			const opts = parsedOptions.data;
			const auth: ThreadsAuth = {
				access_token: request.account.access_token,
				user_id: request.account.platform_account_id,
			};

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Official Threads API docs:
			// - Polls: https://developers.facebook.com/docs/threads/create-posts/polls
			//   POST /threads field `poll_attachment` with option_a..option_d;
			//   polls are limited to text-only posts and 2-4 options of 1-25 chars.
			// - Quote Posts: https://developers.facebook.com/docs/threads/posts/quote-posts
			//   POST /threads field `quote_post_id`.
			// - Location Tagging: https://developers.facebook.com/docs/threads/create-posts/location-tagging
			//   POST /threads field `location_id` (requires threads_location_tagging).
			const extraParams: Record<string, unknown> = {};
			if (opts.topic_tag) extraParams.topic_tag = opts.topic_tag;
			if (opts.reply_control) extraParams.reply_control = opts.reply_control;
			if (opts.link_attachment)
				extraParams.link_attachment = opts.link_attachment;
			if (
				opts.quote_post_id !== undefined &&
				(typeof opts.quote_post_id !== "string" ||
					!/^\d+$/.test(opts.quote_post_id.trim()))
			) {
				return {
					success: false,
					error: {
						code: "INVALID_QUOTE_POST_ID",
						message: "Threads quote_post_id must be a numeric media ID.",
					},
				};
			}
			if (typeof opts.quote_post_id === "string") {
				extraParams.quote_post_id = opts.quote_post_id.trim();
			}
			if (
				opts.location_id !== undefined &&
				(typeof opts.location_id !== "string" ||
					!/^\d+$/.test(opts.location_id.trim()))
			) {
				return {
					success: false,
					error: {
						code: "INVALID_LOCATION_ID",
						message: "Threads location_id must be a numeric Meta location ID.",
					},
				};
			}
			if (typeof opts.location_id === "string") {
				extraParams.location_id = opts.location_id.trim();
			}
			const poll = opts.poll as { options?: unknown } | undefined;
			if (poll) {
				if (
					!Array.isArray(poll.options) ||
					poll.options.length < 2 ||
					poll.options.length > 4 ||
					poll.options.some(
						(option) =>
							typeof option !== "string" ||
							option.length < 1 ||
							option.length > 25,
					)
				) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message:
								"Threads polls require 2-4 options, each 1-25 characters.",
						},
					};
				}
				const providerPoll = Object.fromEntries(
					(poll.options as string[]).map((option, index) => [
						`option_${String.fromCharCode(97 + index)}`,
						option,
					]),
				);
				extraParams.poll_attachment = JSON.stringify(providerPoll);
			}

			// Check for thread sequence
			const threadItems = opts.thread as
				| Array<{
						content: string;
						media?: Array<{ url: string; type?: string }>;
				  }>
				| undefined;

			if (threadItems && threadItems.length > 0) {
				if (poll) {
					return {
						success: false,
						error: {
							code: "POLL_UNSUPPORTED_IN_THREAD",
							message:
								"Threads poll options cannot be combined with RelayAPI thread sequences.",
						},
					};
				}
				const result = await publishThreadSequence(
					auth,
					threadItems,
					request,
					extraParams,
					async (id, index) => {
						const effect: ProviderEffect = {
							name: `thread_item_${index + 1}`,
							status: "succeeded",
							provider_id: id,
						};
						await recordProviderEffect(request, effect);
						threadHasPublished = true;
						threadEffects = mergeProviderEffects(threadEffects, [effect]);
					},
				);
				const username =
					request.account.username ?? request.account.platform_account_id;

				return {
					success: true,
					platform_post_id: result.rootId,
					platform_url:
						result.permalink ?? `https://www.threads.net/@${username}`,
					provider_outcome: {
						disposition: "published",
						platform_post_id: result.rootId,
						platform_url:
							result.permalink ?? `https://www.threads.net/@${username}`,
						effects: threadEffects,
					},
				};
			}

			// Validate the official 500-character limit (see helper source above).
			const contentCharacters = countThreadsCharacters(content);
			if (contentCharacters > 500) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${contentCharacters} characters. Threads limit is 500.`,
					},
				};
			}

			if (poll && media.length > 0) {
				return {
					success: false,
					error: {
						code: "POLL_REQUIRES_TEXT_POST",
						message: "Threads polls can be attached only to text-only posts.",
					},
				};
			}

			const username =
				request.account.username ?? request.account.platform_account_id;

			// Carousel (multiple media)
			if (media.length > 1) {
				const carouselResult = await publishCarousel(
					auth,
					media,
					content || undefined,
					undefined,
					extraParams,
				);

				return {
					success: true,
					platform_post_id: carouselResult.id,
					platform_url:
						carouselResult.permalink ?? `https://www.threads.net/@${username}`,
				};
			}

			// Single post (text, image, or video)
			const singleMedia = media.length === 1 ? media[0] : undefined;

			const singleResult = await publishSinglePost(
				auth,
				content,
				singleMedia,
				undefined,
				extraParams,
			);

			return {
				success: true,
				platform_post_id: singleResult.id,
				platform_url:
					singleResult.permalink ?? `https://www.threads.net/@${username}`,
			};
		} catch (err) {
			const threadItems = request.target_options.thread;
			const isThread = Array.isArray(threadItems) && threadItems.length > 0;
			const result = classifyPublishError(err, {
				safeToRetryRateLimit: !isThread || !threadHasPublished,
				definitiveHttpRejection: isThread && !threadHasPublished,
			});
			if (isThread && threadEffects.length > 0) {
				const rootId = threadEffects[0]?.provider_id;
				const username =
					request.account.username ?? request.account.platform_account_id;
				return {
					...result,
					success: false,
					platform_post_id: rootId,
					platform_url: `https://www.threads.net/@${username}`,
					provider_outcome: {
						disposition: "partial",
						platform_post_id: rootId,
						platform_url: `https://www.threads.net/@${username}`,
						provider_state: `${threadEffects.length}_thread_items_published`,
						effects: [
							...threadEffects,
							{
								name: `thread_item_${threadEffects.length + 1}`,
								status: "outcome_unknown",
								error: result.error,
							},
						],
					},
				};
			}
			return result;
		}
	},
};
