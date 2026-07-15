import { createCipheriv } from "node:crypto";
import {
	awaitResponseWithBodyCompletion,
	ensureResponseContentLength,
	fetchPublicUrl,
	getChunkedResponseBody,
} from "../lib/fetch-public-url";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const SNAPCHAT_API = "https://businessapi.snapchat.com/v1";
const SNAPCHAT_HOST = "https://businessapi.snapchat.com";
// Snap Public Profile multipart uploads accept files up to 1 GB, in no more
// than 35 parts of at most 32 MB each.
// https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement
const SNAPCHAT_MEDIA_MAX_BYTES = 1024 * 1024 * 1024;
// Snap accepts chunked media uploads. Encrypt and send one bounded part at a
// time so plaintext, ciphertext, and multipart encoding never scale with the
// full asset. 31 MB leaves room for CBC padding and stays within 35 parts at
// the 1 GB maximum. The publisher runner also serializes media-bearing targets.
const SNAPCHAT_PLAINTEXT_CHUNK_BYTES = 31 * 1024 * 1024;
const SNAPCHAT_ENCRYPTED_PART_MAX_BYTES = 32 * 1024 * 1024;
const SNAPCHAT_MAX_PARTS = 35;

async function snapchatFetch(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
	// Snapchat rate limits: 20 req/s per app, 10 req/s per token
	// Docs: https://developers.snap.com/api/marketing-api/Ads-API/rate-limits
	if (res.status === 401)
		throw new PublishError(
			`TOKEN_EXPIRED: Snapchat access token invalid or expired`,
			{
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			},
		);
	if (res.status === 429)
		throw new PublishError(`RATE_LIMITED: Snapchat rate limit exceeded`, {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	return res;
}

interface SnapchatMultipartPart {
	body: ReadableStream<Uint8Array>;
	contentLength: number;
	contentType: string;
	completion: Promise<void>;
}

/** Build one multipart part without copying encrypted media into a Blob. */
export function createSnapchatMultipartPart(
	filename: string,
	partNumber: number,
	encryptedChunks: readonly Uint8Array[],
): SnapchatMultipartPart {
	const encryptedBytes = encryptedChunks.reduce(
		(total, chunk) => total + chunk.byteLength,
		0,
	);
	if (
		encryptedBytes <= 0 ||
		encryptedBytes > SNAPCHAT_ENCRYPTED_PART_MAX_BYTES
	) {
		throw new RangeError("Snapchat encrypted upload part is outside its limit");
	}

	const boundary = `relayapi-${crypto.randomUUID()}`;
	const encoder = new TextEncoder();
	const safeFilename = filename.replace(/[\r\n]/g, " ").replace(/["\\]/g, "_");
	const prefix = encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nADD\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="part_number"\r\n\r\n${partNumber}\r\n` +
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
			"Content-Type: application/octet-stream\r\n\r\n",
	);
	const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
	const segments = [prefix, ...encryptedChunks, suffix];
	const contentLength = prefix.byteLength + encryptedBytes + suffix.byteLength;
	let index = 0;
	const combined = new ReadableStream<Uint8Array>({
		pull(controller) {
			const segment = segments[index++];
			if (segment) controller.enqueue(segment);
			else controller.close();
		},
	});

	let body = combined;
	let completion: Promise<void> = Promise.resolve();
	if (typeof FixedLengthStream !== "undefined") {
		const fixed = new FixedLengthStream(contentLength);
		completion = combined.pipeTo(fixed.writable);
		void completion.catch(() => {});
		body = fixed.readable;
	}

	return {
		body,
		contentLength,
		contentType: `multipart/form-data; boundary=${boundary}`,
		completion,
	};
}

async function uploadSnapchatMedia(options: {
	accessToken: string;
	filename: string;
	mediaUrl: string;
	mediaResponse: Response;
	mediaType: "IMAGE" | "VIDEO";
	profileId: string;
}): Promise<string> {
	const {
		accessToken,
		filename,
		mediaUrl,
		mediaResponse,
		mediaType,
		profileId,
	} = options;
	const key = crypto.getRandomValues(new Uint8Array(32));
	const iv = crypto.getRandomValues(new Uint8Array(16));
	const keyB64 = btoa(String.fromCharCode(...key));
	const ivB64 = btoa(String.fromCharCode(...iv));

	let sourceClaimed = false;
	let sourceResponse = mediaResponse;
	try {
		sourceResponse = await ensureResponseContentLength(
			mediaResponse,
			SNAPCHAT_MEDIA_MAX_BYTES,
			() =>
				fetchPublicUrl(mediaUrl, {
					timeout: 30_000,
					maxBytes: SNAPCHAT_MEDIA_MAX_BYTES,
				}),
		);

		// Snap Public Profile API requires AES-256-CBC encrypted media uploads.
		// https://developers.snap.com/api/marketing-api/Public-Profile-API/ProfileAssetManagement
		const createMediaRes = await snapchatFetch(
			`${SNAPCHAT_API}/public_profiles/${profileId}/media`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					type: mediaType,
					name: filename,
					key: keyB64,
					iv: ivB64,
				}),
			},
		);

		if (!createMediaRes.ok) {
			const err = await createMediaRes
				.text()
				.catch(() => createMediaRes.statusText);
			const raw = `HTTP ${createMediaRes.status}\n${err}`;
			throw new PublishError(
				`Snapchat media container creation failed: ${err}`,
				{ statusCode: createMediaRes.status, detail: raw },
			);
		}

		const createMediaResult = (await createMediaRes.json()) as {
			media_id?: string;
			add_path?: string;
			finalize_path?: string;
		};
		const mediaId = createMediaResult.media_id;
		const addPath = createMediaResult.add_path;
		const finalizePath = createMediaResult.finalize_path;
		if (!mediaId || !addPath || !finalizePath) {
			throw new Error(
				"Snapchat media container creation did not return media_id, add_path, or finalize_path.",
			);
		}

		const cipher = createCipheriv("aes-256-cbc", key, iv);
		const source = getChunkedResponseBody(
			sourceResponse,
			SNAPCHAT_MEDIA_MAX_BYTES,
			SNAPCHAT_PLAINTEXT_CHUNK_BYTES,
		);
		sourceClaimed = true;
		const totalPlaintextChunks = Math.ceil(
			source.contentLength / SNAPCHAT_PLAINTEXT_CHUNK_BYTES,
		);
		let plaintextChunkNumber = 0;
		let partNumber = 0;
		const uploadPart = async (encryptedChunks: readonly Uint8Array[]) => {
			partNumber++;
			if (partNumber > SNAPCHAT_MAX_PARTS) {
				throw new Error("Snapchat media upload exceeded 35 parts");
			}
			const multipart = createSnapchatMultipartPart(
				filename,
				partNumber,
				encryptedChunks,
			);

			const uploadRes = await awaitResponseWithBodyCompletion(
				fetch(`${SNAPCHAT_HOST}${addPath}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": multipart.contentType,
						"Content-Length": multipart.contentLength.toString(),
					},
					body: multipart.body,
				}),
				multipart.completion,
			);
			if (!uploadRes.ok) {
				const err = await uploadRes.text().catch(() => uploadRes.statusText);
				const raw = `HTTP ${uploadRes.status}\n${err}`;
				throw new PublishError(`Snapchat media upload failed: ${err}`, {
					statusCode: uploadRes.status,
					detail: raw,
				});
			}
		};

		for await (const plaintext of source.chunks) {
			plaintextChunkNumber++;
			const update = cipher.update(plaintext);
			const finalBlock =
				plaintextChunkNumber === totalPlaintextChunks
					? cipher.final()
					: undefined;
			await uploadPart(finalBlock ? [update, finalBlock] : [update]);
		}

		if (plaintextChunkNumber !== totalPlaintextChunks) {
			throw new Error(
				`Snapchat media upload consumed ${plaintextChunkNumber} chunks, expected ${totalPlaintextChunks}`,
			);
		}

		const finalizeForm = new FormData();
		finalizeForm.append("action", "FINALIZE");
		const finalizeRes = await fetch(`${SNAPCHAT_HOST}${finalizePath}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			body: finalizeForm,
		});
		if (!finalizeRes.ok) {
			const err = await finalizeRes.text().catch(() => finalizeRes.statusText);
			const raw = `HTTP ${finalizeRes.status}\n${err}`;
			throw new PublishError(`Snapchat media finalize failed: ${err}`, {
				statusCode: finalizeRes.status,
				detail: raw,
			});
		}

		return mediaId;
	} finally {
		// Before the chunk generator claims the response, failures must explicitly
		// release the download connection. Once claimed, its finally block cancels
		// the reader whenever an upload stops early.
		if (!sourceClaimed) {
			await sourceResponse.body?.cancel().catch(() => {});
		}
	}
}

type ContentType = "story" | "saved_story" | "spotlight";

export const snapchatPublisher: Publisher = {
	platform: "snapchat",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			const opts = request.target_options;

			// Profile ID is required for all Snapchat Public Profile API calls
			const profileId = opts.profile_id as string | undefined;
			if (!profileId) {
				return {
					success: false,
					error: {
						code: "PROFILE_ID_REQUIRED",
						message:
							"Snapchat requires a profile_id in target_options. Provide your Public Profile ID.",
					},
				};
			}

			// Resolve media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Snapchat requires media — no text-only posts
			if (media.length === 0) {
				return {
					success: false,
					error: {
						code: "MEDIA_REQUIRED",
						message:
							"Snapchat requires media. Text-only posts are not supported.",
					},
				};
			}

			// Single media item only
			if (media.length > 1) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message: "Snapchat supports a single media item only.",
					},
				};
			}

			const mediaItem = media[0];
			const isVideo = mediaItem?.type === "video";

			// Content type
			const contentType = (opts.content_type as ContentType) ?? "story";

			// Validate content type
			if (!["story", "saved_story", "spotlight"].includes(contentType)) {
				return {
					success: false,
					error: {
						code: "INVALID_CONTENT_TYPE",
						message: `Invalid content_type "${contentType}". Must be "story", "saved_story", or "spotlight".`,
					},
				};
			}

			// Spotlight requires video only
			if (contentType === "spotlight" && !isVideo) {
				return {
					success: false,
					error: {
						code: "VIDEO_REQUIRED",
						message: "Snapchat Spotlight only supports video content.",
					},
				};
			}

			// Resolve content
			const content = (opts.content as string) ?? request.content ?? "";

			// Validate content length per content type
			if (contentType === "saved_story" && content.length > 45) {
				return {
					success: false,
					error: {
						code: "TITLE_TOO_LONG",
						message: `Saved Story title is ${content.length} characters. Snapchat limit is 45.`,
					},
				};
			}

			if (contentType === "spotlight" && content.length > 160) {
				return {
					success: false,
					error: {
						code: "DESCRIPTION_TOO_LONG",
						message: `Spotlight description is ${content.length} characters. Snapchat limit is 160.`,
					},
				};
			}

			// Fetch media bytes
			const mediaRes = await fetchPublicUrl(mediaItem?.url ?? "", {
				timeout: 30_000,
				maxBytes: SNAPCHAT_MEDIA_MAX_BYTES,
			});
			if (!mediaRes.ok) {
				return {
					success: false,
					error: {
						code: "MEDIA_FETCH_FAILED",
						message: `Failed to fetch media from ${mediaItem?.url}: ${mediaRes.statusText}`,
					},
				};
			}

			const filename = `media_${Date.now()}.${isVideo ? "mp4" : "jpg"}`;
			const mediaId = await uploadSnapchatMedia({
				accessToken,
				filename,
				mediaUrl: mediaItem?.url ?? "",
				mediaResponse: mediaRes,
				mediaType: isVideo ? "VIDEO" : "IMAGE",
				profileId,
			});

			// Create the post using the finalized media_id.
			let endpoint: string;
			let postBody: Record<string, unknown>;

			switch (contentType) {
				case "story": {
					endpoint = `${SNAPCHAT_API}/public_profiles/${profileId}/stories`;
					postBody = { media_id: mediaId };
					break;
				}
				case "saved_story": {
					// Saved stories require a nested saved_stories array with snap_sources
					endpoint = `${SNAPCHAT_API}/public_profiles/${profileId}/saved_stories`;
					postBody = {
						saved_stories: [
							{
								...(content ? { title: content } : {}),
								snap_sources: [{ media_id: mediaId }],
							},
						],
					};
					break;
				}
				case "spotlight": {
					endpoint = `${SNAPCHAT_API}/public_profiles/${profileId}/spotlights`;
					const locale = (opts.locale as string) ?? "en_US";
					postBody = {
						media_id: mediaId,
						locale,
					};
					if (content) {
						postBody.description = content;
					}
					break;
				}
			}

			const postRes = await snapchatFetch(endpoint, accessToken, {
				method: "POST",
				body: JSON.stringify(postBody),
			});

			if (!postRes.ok) {
				const err = await postRes.json().catch(() => ({}));
				const raw = `HTTP ${postRes.status}\n${JSON.stringify(err)}`;
				const detail =
					(err as { message?: string }).message ?? postRes.statusText;
				throw new PublishError(`Snapchat post creation failed: ${detail}`, {
					statusCode: postRes.status,
					detail: raw,
				});
			}

			const postResult = (await postRes.json()) as Record<string, unknown>;

			// Response shape varies per content type:
			// Story: { request_id, request_status }
			// Saved story: { saved_stories: [{ id }] }
			// Spotlight: { spotlight_id, request_id, request_status }
			let postId: string | undefined;
			if (contentType === "spotlight") {
				postId = postResult.spotlight_id as string | undefined;
			} else if (contentType === "saved_story") {
				const savedStories = postResult.saved_stories as
					| Array<{ saved_story?: { id?: string } }>
					| undefined;
				postId = savedStories?.[0]?.saved_story?.id;
			} else {
				postId =
					(postResult.request_id as string | undefined) ??
					(postResult.id as string | undefined);
			}

			return {
				success: true,
				platform_post_id: postId,
				platform_url: postResult.url as string | undefined,
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
