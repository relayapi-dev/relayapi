import { mapConcurrently } from "../lib/concurrency";
import {
	awaitResponseWithBodyCompletion,
	fetchPublicUrl,
	readResponseBytes,
	readResponseJson,
} from "../lib/fetch-public-url";
import { createStreamingMultipartBody } from "../lib/multipart-stream";
import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

interface MastodonMediaLimits {
	imageBytes: number;
	videoBytes: number;
	maxAttachments: number;
}

const MASTODON_INSTANCE_RESPONSE_MAX_BYTES = 512 * 1024;
const MASTODON_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

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
	const url = new URL(path, `${instanceUrl.replace(/\/+$/, "")}/`);
	return fetchPublicUrl(url, {
		...options,
		// Never follow a provider redirect while carrying an OAuth bearer token.
		// fetchPublicUrl also rejects private/reserved destinations after DNS
		// resolution, which keeps a compromised account record from becoming SSRF.
		redirect: "error",
		timeout: 30_000,
		headers: {
			Authorization: `Bearer ${token}`,
			...(options.headers ?? {}),
		},
	});
}

/**
 * Return the immutable provider origin recorded by the connection flow.
 * A publish request must never be allowed to choose where its bearer token is
 * sent. The connector is responsible for discovering and persisting this value.
 */
export function resolveMastodonInstanceUrl(
	metadata: Record<string, unknown> | null | undefined,
): string {
	const raw = metadata?.instance_url;
	if (typeof raw !== "string" || !raw.trim()) {
		throw new PublishError(
			"CONTENT_ERROR: This Mastodon account is missing its connected instance URL. Reconnect the account before publishing.",
			{ code: "MASTODON_RECONNECT_REQUIRED" },
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new PublishError(
			"CONTENT_ERROR: This Mastodon account has an invalid connected instance URL. Reconnect the account before publishing.",
			{ code: "MASTODON_RECONNECT_REQUIRED" },
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		(parsed.pathname !== "/" && parsed.pathname !== "")
	) {
		throw new PublishError(
			"CONTENT_ERROR: The connected Mastodon instance must be a bare HTTPS origin. Reconnect the account before publishing.",
			{ code: "MASTODON_RECONNECT_REQUIRED" },
		);
	}
	return parsed.origin;
}

function isValidMediaLimit(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isSafeInteger(value) &&
		value > 0
	);
}

/**
 * Mastodon instances advertise their own media byte limits.
 * Docs: https://docs.joinmastodon.org/methods/instance/#v2
 * "View server information" documents GET /api/v2/instance as added in 4.0.0.
 * The same page's "View server information (v1)" section documents
 * GET /api/v1/instance and its configuration fields for pre-4.0 servers.
 */
async function getMediaLimits(
	instanceUrl: string,
	token: string,
): Promise<MastodonMediaLimits> {
	let res = await mastodonFetch(instanceUrl, "/api/v2/instance", token);
	if (!res.ok) {
		const v2Status = res.status;
		await res.body?.cancel().catch(() => {});
		res = await mastodonFetch(instanceUrl, "/api/v1/instance", token);
		if (res.ok) {
			// Mastodon 3.x exposes these limits from the deprecated v1 endpoint.
			// Falling back keeps otherwise compatible pre-4.0 instances publishable.
		} else {
			const detail = await readResponseBytes(
				res,
				MASTODON_ERROR_RESPONSE_MAX_BYTES,
			)
				.then((bytes) => new TextDecoder().decode(bytes))
				.catch(() => "");
			throw new PublishError(
				`Unable to determine Mastodon instance media limits: v2 returned HTTP ${v2Status}; v1 returned HTTP ${res.status}`,
				{
					statusCode: res.status,
					detail: `HTTP ${res.status}\n${detail}`,
				},
			);
		}
	}

	let data: unknown;
	try {
		data = await readResponseJson(res, MASTODON_INSTANCE_RESPONSE_MAX_BYTES);
	} catch {
		throw new PublishError(
			"Unable to determine Mastodon instance media limits: invalid instance configuration response",
			{ code: "PLATFORM_ERROR" },
		);
	}

	const mediaAttachments = ((
		data as { configuration?: { media_attachments?: unknown } }
	).configuration?.media_attachments ?? null) as Record<string, unknown> | null;
	const statuses = ((data as { configuration?: { statuses?: unknown } })
		.configuration?.statuses ?? null) as Record<string, unknown> | null;
	const imageBytes = mediaAttachments?.image_size_limit;
	const videoBytes = mediaAttachments?.video_size_limit;
	const advertisedMaxAttachments = statuses?.max_media_attachments;
	if (!isValidMediaLimit(imageBytes) || !isValidMediaLimit(videoBytes)) {
		throw new PublishError(
			"Unable to determine Mastodon instance media limits: image_size_limit and video_size_limit must be positive safe integers",
			{ code: "PLATFORM_ERROR" },
		);
	}
	// Official docs: https://docs.joinmastodon.org/user/posting/
	// Section "Attachments > Files" documents four images per post. Modern
	// instances override this through Instance.configuration.statuses;
	// retain the documented default for older compatible instance responses.
	const maxAttachments = isValidMediaLimit(advertisedMaxAttachments)
		? advertisedMaxAttachments
		: 4;

	return { imageBytes, videoBytes, maxAttachments };
}

function getMediaMaxBytes(
	media: { type?: string },
	limits: MastodonMediaLimits,
): number {
	// Official docs: https://docs.joinmastodon.org/user/posting/
	// Section "Attachments" > "Files" places static and animated GIFs in the
	// 16 MB image/GIF tier, while videos use the separate 99 MB tier.
	return media.type === undefined ||
		media.type === "image" ||
		media.type === "gif"
		? limits.imageBytes
		: limits.videoBytes;
}

/**
 * Upload media to the Mastodon instance.
 * Returns the media attachment ID.
 */
async function uploadMedia(
	instanceUrl: string,
	token: string,
	mediaUrl: string,
	maxBytes: number,
	description?: string,
): Promise<string> {
	// Fetch the media file
	const mediaRes = await fetchPublicUrl(mediaUrl, {
		timeout: 30_000,
		maxBytes,
	});
	if (!mediaRes.ok) {
		throw new PublishError(
			`Failed to fetch media from ${mediaUrl}: ${mediaRes.statusText}`,
			{
				statusCode: mediaRes.status,
				detail: `HTTP ${mediaRes.status} ${mediaRes.statusText}`,
			},
		);
	}
	const multipart = await createStreamingMultipartBody(
		description ? [["description", description]] : [],
		{
			fieldName: "file",
			filename: "media",
			contentType:
				mediaRes.headers.get("content-type") ?? "application/octet-stream",
			response: mediaRes,
			maxBytes,
			refetch: () =>
				fetchPublicUrl(mediaUrl, {
					timeout: 30_000,
					maxBytes,
				}),
		},
	);

	// Mastodon API v2: Upload media attachment
	// Docs: https://docs.joinmastodon.org/methods/media/#v2
	const res = await awaitResponseWithBodyCompletion(
		mastodonFetch(instanceUrl, "/api/v2/media", token, {
			method: "POST",
			headers: {
				"Content-Type": multipart.contentType,
				"Content-Length": multipart.contentLength.toString(),
			},
			body: multipart.body,
		}),
		multipart.completion,
	);

	if (!res.ok) {
		const err = await readPublisherText(res).catch(() => "");
		const raw = `HTTP ${res.status}\n${err}`;
		throw new PublishError(
			`Mastodon media upload failed: ${res.status} ${err}`,
			{
				statusCode: res.status,
				detail: raw,
			},
		);
	}

	const data = (await readPublisherJson(res)) as {
		id: string;
		url: string | null;
	};

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
				throw new PublishError(
					`Mastodon media poll failed: ${pollRes.status}`,
					{
						statusCode: pollRes.status,
						detail: `HTTP ${pollRes.status} ${pollRes.statusText}`,
					},
				);
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
			const opts = request.target_options;

			const content = (opts.content as string) ?? request.content ?? "";
			const visibility = (opts.visibility as string) ?? "public";
			const spoilerText = opts.spoiler_text as string | undefined;
			const sensitive = opts.sensitive as boolean | undefined;
			const inReplyToId = opts.in_reply_to_id as string | undefined;

			// Upload media if present (Mastodon limits: 4 images or 1 video/gif)
			const media =
				(opts.media as Array<{
					url: string;
					alt_text?: string;
					type?: string;
				}>) ?? request.media;
			const poll = opts.poll as
				| {
						options?: string[];
						expires_in?: number;
						multiple?: boolean;
						hide_totals?: boolean;
				  }
				| undefined;
			if (poll) {
				if (!Array.isArray(poll.options) || poll.options.length < 2) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message: "Mastodon polls require at least two options.",
						},
					};
				}
				if (poll.options.length > 4) {
					return {
						success: false,
						error: {
							code: "INVALID_POLL",
							message: "Mastodon polls support at most four options.",
						},
					};
				}
				if (media.length > 0) {
					return {
						success: false,
						error: {
							code: "INVALID_MEDIA_MIX",
							message: "Mastodon polls cannot be combined with media.",
						},
					};
				}
			}
			const hasDocument = media.some((item) => item.type === "document");
			// Official docs: https://docs.joinmastodon.org/user/posting/
			// Section "Attachments > Files" lists images, animated GIF, video,
			// and audio as attachment types; generic document files are not listed.
			if (hasDocument) {
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message: "Mastodon does not support generic document attachments.",
					},
				};
			}

			// The destination is connection-owned metadata. In particular, never use
			// target_options.instance_url here: doing so would disclose the bearer
			// token to a caller-controlled host.
			const instanceUrl = resolveMastodonInstanceUrl(request.account.metadata);
			let mediaIds: string[] | undefined;

			if (media.length > 0) {
				const hasVideo = media.some(
					(m) =>
						(m as { type?: string }).type === "video" ||
						(m as { type?: string }).type === "gif",
				);

				const mediaLimits = await getMediaLimits(instanceUrl, token);

				// The same official section allows one video or animated GIF per post.
				if (hasVideo && media.length !== 1) {
					return {
						success: false,
						error: {
							code: "INVALID_MEDIA_MIX",
							message:
								"Mastodon supports one video or animated GIF, without other attachments.",
						},
					};
				}

				if (!hasVideo && media.length > mediaLimits.maxAttachments) {
					// Official docs: https://docs.joinmastodon.org/entities/Instance/
					// Field `configuration.statuses.max_media_attachments` is the
					// instance-specific maximum; do not silently discard extra images.
					return {
						success: false,
						error: {
							code: "TOO_MANY_MEDIA",
							message: `This Mastodon instance supports at most ${mediaLimits.maxAttachments} media attachments.`,
						},
					};
				}

				mediaIds = await mapConcurrently(media, 2, (m) =>
					uploadMedia(
						instanceUrl,
						token,
						m.url,
						getMediaMaxBytes(m, mediaLimits),
						m.alt_text,
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
			if (poll) {
				body.poll = {
					options: poll.options as string[],
					expires_in: poll.expires_in ?? 86400,
					multiple: poll.multiple ?? false,
					hide_totals: poll.hide_totals ?? false,
				};
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
					"Idempotency-Key": request.operation_id,
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const err = await readPublisherJson(res).catch(() => ({}));
				const detail = (err as { error?: string }).error ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(`Mastodon post creation failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}

			const result = (await readPublisherJson(res)) as {
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
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
