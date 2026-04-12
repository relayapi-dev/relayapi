import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

/**
 * Mastodon publisher.
 * Each Mastodon account connects to a specific instance (e.g., mastodon.social).
 * The instance URL is stored in account.metadata.instance_url.
 * The access token is a user-level OAuth token with write:statuses and write:media scopes.
 */

async function mastodonFetch(
	instanceUrl: string,
	path: string,
	token: string,
	options: RequestInit = {},
): Promise<Response> {
	const url = `${instanceUrl.replace(/\/+$/, "")}${path}`;
	return fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			...(options.headers ?? {}),
		},
	});
}

/**
 * Upload media to the Mastodon instance.
 * Returns the media attachment ID.
 */
async function uploadMedia(
	instanceUrl: string,
	token: string,
	mediaUrl: string,
	description?: string,
): Promise<string> {
	// Fetch the media file
	const mediaRes = await fetchPublicUrl(mediaUrl, { timeout: 30_000 });
	if (!mediaRes.ok) {
		throw new Error(`Failed to fetch media from ${mediaUrl}: ${mediaRes.statusText}`);
	}
	const blob = await mediaRes.blob();

	const formData = new FormData();
	formData.append("file", blob);
	if (description) {
		formData.append("description", description);
	}

	// Mastodon API v2: Upload media attachment
	// Docs: https://docs.joinmastodon.org/methods/media/#v2
	const res = await mastodonFetch(instanceUrl, "/api/v2/media", token, {
		method: "POST",
		body: formData,
	});

	if (!res.ok) {
		const err = await res.text().catch(() => "");
		throw new Error(`Mastodon media upload failed: ${res.status} ${err}`);
	}

	const data = (await res.json()) as { id: string; url: string | null };

	// 202 Accepted means async processing (video/audio/GIF) — poll until ready
	// Mastodon API: Get media attachment by ID (poll for processing completion)
	// https://docs.joinmastodon.org/methods/media/#get
	if (res.status === 202) {
		let processed = false;
		const maxPollAttempts = 30;
		for (let i = 0; i < maxPollAttempts; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const pollRes = await mastodonFetch(
				instanceUrl,
				`/api/v1/media/${data.id}`,
				token,
			);
			// 200 = processing complete, 206 = still processing
			if (pollRes.status === 200) {
				processed = true;
				break;
			}
			if (!pollRes.ok && pollRes.status !== 206) {
				throw new Error(`Mastodon media poll failed: ${pollRes.status}`);
			}
		}
		if (!processed) {
			throw new Error("Mastodon media processing timed out after 30 attempts");
		}
	}

	return data.id;
}

export const mastodonPublisher: Publisher = {
	platform: "mastodon",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const token = request.account.access_token;
			// Instance URL should be stored in account metadata during connect
			const accountMetadata = ((request.account as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;
			const instanceUrl = (accountMetadata.instance_url as string)
				?? (request.target_options.instance_url as string)
				?? "https://mastodon.social";
			const opts = request.target_options;

			const content = (opts.content as string) ?? request.content ?? "";
			const visibility = (opts.visibility as string) ?? "public";
			const spoilerText = opts.spoiler_text as string | undefined;
			const sensitive = opts.sensitive as boolean | undefined;
			const inReplyToId = opts.in_reply_to_id as string | undefined;

			// Upload media if present (Mastodon limits: 4 images or 1 video/gif)
			const media = (opts.media as Array<{ url: string; alt?: string; type?: string }>) ?? request.media;
			let mediaIds: string[] | undefined;

			if (media.length > 0) {
				const hasVideo = media.some((m) => (m as { type?: string }).type === "video" || (m as { type?: string }).type === "gif");

				// Mastodon requires consistent media types in groups
				// Photos/videos can mix, but documents/audio cannot mix with other types
				// Docs: https://docs.joinmastodon.org/user/posting/
				const hasDocument = media.some((m) => (m as { type?: string }).type === "document");
				const hasImage = media.some((m) => !(m as { type?: string }).type || (m as { type?: string }).type === "image");
				if (hasDocument && (hasVideo || hasImage)) {
					return {
						success: false,
						error: {
							code: "INVALID_MEDIA_MIX",
							message: "Mastodon does not allow mixing documents with images or videos.",
						},
					};
				}

				const mediaSlice = hasVideo ? media.slice(0, 1) : media.slice(0, 4);
				mediaIds = await Promise.all(
					mediaSlice.map((m) =>
						uploadMedia(
							instanceUrl,
							token,
							m.url,
							(m as { alt?: string }).alt,
						),
					),
				);
			}

			// Mastodon API: Create a new status (post)
			// Docs: https://docs.joinmastodon.org/methods/statuses/#create
			const body: Record<string, unknown> = {
				status: content,
				visibility,
			};

			const language = opts.language as string | undefined;
			if (language) {
				body.language = language;
			}

			if (mediaIds && mediaIds.length > 0) {
				body.media_ids = mediaIds;
			}
			if (spoilerText) {
				body.spoiler_text = spoilerText;
			}
			if (sensitive !== undefined) {
				body.sensitive = sensitive;
			}
			if (inReplyToId) {
				body.in_reply_to_id = inReplyToId;
			}

			// Mastodon API: Poll parameters
			// Docs: https://docs.joinmastodon.org/methods/statuses/#create
			const poll = opts.poll as { options?: string[]; expires_in?: number; multiple?: boolean; hide_totals?: boolean } | undefined;
			if (poll?.options && poll.options.length >= 2) {
				// Polls cannot be combined with media
				if (!mediaIds || mediaIds.length === 0) {
					body.poll = {
						options: poll.options.slice(0, 4),
						expires_in: poll.expires_in ?? 86400,
						multiple: poll.multiple ?? false,
						hide_totals: poll.hide_totals ?? false,
					};
				}
			}

			// Mastodon 4.5.0+: Quote posts
			// Docs: https://docs.joinmastodon.org/methods/statuses/#create
			const quotedStatusId = opts.quoted_status_id as string | undefined;
			if (quotedStatusId) {
				body.quoted_status_id = quotedStatusId;
			}

			const res = await mastodonFetch(instanceUrl, "/api/v1/statuses", token, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": crypto.randomUUID(),
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail = (err as { error?: string }).error ?? res.statusText;
				throw new Error(`Mastodon post creation failed: ${detail}`);
			}

			const result = (await res.json()) as {
				id: string;
				url: string;
				account: { username: string };
			};

			return {
				success: true,
				platform_post_id: result.id,
				platform_url: result.url,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
