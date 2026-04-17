import { GRAPH_BASE } from "../config/api-versions";
import { classifyPublishError, type EngagementAccount, type EngagementActionResult, type Publisher, type PublishRequest, type PublishResult } from "./types";

const GRAPH_API = GRAPH_BASE.threads;

interface ThreadsAuth {
	access_token: string;
	user_id: string;
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
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string; code?: number; error_subcode?: number };
		};
		const detail = err.error?.message ?? res.statusText;
		const errCode = err.error?.code;
		const errSubcode = err.error?.error_subcode;
		// Detect token expiration
		// Docs: https://developers.facebook.com/docs/threads/troubleshooting
		if (errCode === 190 || detail.includes("Error validating access token") || detail.includes("session has been invalidated")) {
			throw new Error(`TOKEN_EXPIRED: ${detail}`);
		}
		if (errSubcode === 4 || res.status === 429) {
			throw new Error(`RATE_LIMITED: ${detail}`);
		}
		throw new Error(`Threads API error: ${detail}`);
	}

	return res.json() as Promise<Record<string, unknown>>;
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
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		throw new Error(`Threads API error: ${detail}`);
	}

	return res.json() as Promise<Record<string, unknown>>;
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
): Promise<{ id: string; permalink: string | null }> {
	// Threads API: Publish a media container (step 2 of publishing)
	// Docs: https://developers.facebook.com/docs/threads/posts#step-2--publish-a-threads-media-container
	const result = await graphPost(`/${auth.user_id}/threads_publish`, auth, {
		creation_id: containerId,
	});
	const postId = result.id as string;

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
	media?: { url: string; type?: string },
	replyToId?: string,
	extraParams?: Record<string, unknown>,
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

	const published = await publishContainer(auth, containerId);
	return published;
}

/**
 * Publish a carousel post with up to 10 items.
 */
async function publishCarousel(
	auth: ThreadsAuth,
	items: Array<{ url: string; type?: string }>,
	text?: string,
	replyToId?: string,
	extraParams?: Record<string, unknown>,
): Promise<{ id: string; permalink: string | null }> {
	// Threads carousels require 2-20 items
	if (items.length < 2) {
		throw new Error("Threads carousel requires at least 2 media items.");
	}

	// Create child containers
	const childIds: string[] = [];

	for (const item of items.slice(0, 20)) {
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

	return publishContainer(auth, parentId);
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
): Promise<{ rootId: string; permalink: string | null }> {
	let rootId: string | undefined;
	let rootPermalink: string | null = null;
	let previousId: string | undefined;

	for (const item of items) {
		// Validate character limit per item
		const itemBytes = new TextEncoder().encode(item.content).byteLength;
		if (itemBytes > 500) {
			throw new Error(
				`Thread item exceeds 500 byte limit (${itemBytes} bytes)`,
			);
		}

		let published: { id: string; permalink: string | null };

		if (item.media && item.media.length > 1) {
			// Carousel in thread
			published = await publishCarousel(
				auth,
				item.media,
				item.content || undefined,
				previousId,
			);
		} else if (item.media && item.media.length === 1) {
			// Single media in thread
			published = await publishSinglePost(
				auth,
				item.content,
				item.media[0],
				previousId,
			);
		} else {
			// Text-only in thread
			published = await publishSinglePost(
				auth,
				item.content,
				undefined,
				previousId,
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

	async comment(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const auth: ThreadsAuth = {
				access_token: account.access_token,
				user_id: account.platform_account_id,
			};
			const result = await publishSinglePost(auth, text, undefined, platformPostId);
			return { success: true, platform_post_id: result.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const opts = request.target_options;
			const auth: ThreadsAuth = {
				access_token: request.account.access_token,
				user_id: request.account.platform_account_id,
			};

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Check for thread sequence
			const threadItems = opts.thread as
				| Array<{
						content: string;
						media?: Array<{ url: string; type?: string }>;
				  }>
				| undefined;

			if (threadItems && threadItems.length > 0) {
				const result = await publishThreadSequence(auth, threadItems);
				const username =
					request.account.username ?? request.account.platform_account_id;

				return {
					success: true,
					platform_post_id: result.rootId,
					platform_url: result.permalink ?? `https://www.threads.net/@${username}`,
				};
			}

			// Validate character limit
			// Threads counts characters by UTF-8 bytes for emoji
			// Docs: https://developers.facebook.com/docs/threads/overview
			const contentBytes = new TextEncoder().encode(content).byteLength;
			if (contentBytes > 500) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${contentBytes} bytes (UTF-8). Threads limit is 500.`,
					},
				};
			}

			const extraParams: Record<string, unknown> = {};
			if (opts.topic_tag) extraParams.topic_tag = opts.topic_tag;
			if (opts.reply_control) extraParams.reply_control = opts.reply_control;
			if (opts.link_attachment) extraParams.link_attachment = opts.link_attachment;

			let postId: string;
			const username =
				request.account.username ?? request.account.platform_account_id;

			// Carousel (multiple media)
			if (media.length > 1) {
				const carouselResult = await publishCarousel(auth, media, content || undefined, undefined, extraParams);

				return {
					success: true,
					platform_post_id: carouselResult.id,
					platform_url: carouselResult.permalink ?? `https://www.threads.net/@${username}`,
				};
			}

			// Single post (text, image, or video)
			const singleMedia = media.length === 1 ? media[0] : undefined;

			const singleResult = await publishSinglePost(auth, content, singleMedia, undefined, extraParams);

			return {
				success: true,
				platform_post_id: singleResult.id,
				platform_url: singleResult.permalink ?? `https://www.threads.net/@${username}`,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
