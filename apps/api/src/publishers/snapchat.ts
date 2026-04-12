import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const SNAPCHAT_API = "https://businessapi.snapchat.com/v1";

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
	if (res.status === 401) throw new Error(`TOKEN_EXPIRED: Snapchat access token invalid or expired`);
	if (res.status === 429) throw new Error(`RATE_LIMITED: Snapchat rate limit exceeded`);
	return res;
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

			const mediaBytes = await mediaRes.arrayBuffer();
			const mediaMimeType =
				mediaRes.headers.get("content-type") ??
				(isVideo ? "video/mp4" : "image/jpeg");

			// --- Step 1: Encrypt the media with AES-256-CBC ---
			// Snap Public Profile API requires encrypted media uploads
			// https://developers.snap.com/api/marketing-api/Public-Profile-API/ProfileAssetManagement
			const mediaType = isVideo ? "VIDEO" : "IMAGE";

			const key = crypto.getRandomValues(new Uint8Array(32));
			const iv = crypto.getRandomValues(new Uint8Array(16));

			const cryptoKey = await crypto.subtle.importKey(
				"raw",
				key,
				{ name: "AES-CBC" },
				false,
				["encrypt"],
			);
			const encrypted = await crypto.subtle.encrypt(
				{ name: "AES-CBC", iv },
				cryptoKey,
				mediaBytes,
			);

			// Base64-encode key and IV for the API
			const keyB64 = btoa(String.fromCharCode(...key));
			const ivB64 = btoa(String.fromCharCode(...iv));

			const filename = `media_${Date.now()}.${isVideo ? "mp4" : "jpg"}`;

			// --- Step 2: Create media container ---
			// POST /v1/public_profiles/{profile_id}/media with encryption details
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
				throw new Error(`Snapchat media container creation failed: ${err}`);
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

			// --- Step 3: Upload encrypted binary via multipart POST ---
			const uploadForm = new FormData();
			uploadForm.append("action", "ADD");
			uploadForm.append("part_number", "1");
			uploadForm.append("file", new Blob([encrypted], { type: "application/octet-stream" }), filename);

			// add_path/finalize_path are relative — prepend the host for absolute URLs
			const snapchatHost = "https://businessapi.snapchat.com";

			const uploadRes = await fetch(`${snapchatHost}${addPath}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
				body: uploadForm,
			});

			if (!uploadRes.ok) {
				const err = await uploadRes
					.text()
					.catch(() => uploadRes.statusText);
				throw new Error(`Snapchat media upload failed: ${err}`);
			}

			// --- Step 4: Finalize the upload (multipart form, not JSON) ---
			const finalizeForm = new FormData();
			finalizeForm.append("action", "FINALIZE");

			const finalizeRes = await fetch(`${snapchatHost}${finalizePath}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
				body: finalizeForm,
			});

			if (!finalizeRes.ok) {
				const err = await finalizeRes
					.text()
					.catch(() => finalizeRes.statusText);
				throw new Error(`Snapchat media finalize failed: ${err}`);
			}

			// --- Step 5: Create post using the media_id ---
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
						saved_stories: [{
							...(content ? { title: content } : {}),
							snap_sources: [{ media_id: mediaId }],
						}],
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
				const detail =
					(err as { message?: string }).message ?? postRes.statusText;
				throw new Error(`Snapchat post creation failed: ${detail}`);
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
				const savedStories = postResult.saved_stories as Array<{ saved_story?: { id?: string } }> | undefined;
				postId = savedStories?.[0]?.saved_story?.id;
			} else {
				postId = (postResult.request_id as string | undefined) ?? (postResult.id as string | undefined);
			}

			return {
				success: true,
				platform_post_id: postId,
				platform_url: postResult.url as string | undefined,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
