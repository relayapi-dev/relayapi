import {
	awaitResponseWithBodyCompletion,
	fetchPublicUrl,
} from "../lib/fetch-public-url";
import { createStreamingMultipartBody } from "../lib/multipart-stream";
import { readPublisherJson } from "./provider-response";
import {
	classifyPublishError,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
} from "./types";

const PINTEREST_API = "https://api.pinterest.com/v5";
// Pinterest video Pins support files up to 2 GB.
// https://help.pinterest.com/en/business/article/pinterest-product-specs
const PINTEREST_VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;

async function pinterestFetch(
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
	if (res.status === 401)
		throw new PublishError(
			"TOKEN_EXPIRED: Pinterest access token invalid or expired",
			{
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			},
		);
	if (res.status === 429)
		throw new PublishError("RATE_LIMITED: Pinterest rate limit exceeded", {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	return res;
}

export const pinterestPublisher: Publisher = {
	platform: "pinterest",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			const opts = request.target_options;

			// Resolve content — used as description
			const description = (opts.content as string) ?? request.content ?? "";

			// Resolve media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Pinterest requires media — no text-only pins
			if (media.length === 0) {
				return {
					success: false,
					error: {
						code: "MEDIA_REQUIRED",
						message:
							"Pinterest requires an image or video. Text-only pins are not supported.",
					},
				};
			}

			// Pinterest supports up to 5 images per carousel pin, or 1 video
			const videoCount = media.filter((m) => m.type === "video").length;
			const unsupportedMedia = media.some(
				(m) => m.type && m.type !== "image" && m.type !== "video",
			);
			if (unsupportedMedia) {
				// Official docs: https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
				// Section "Step 4: Create Pin" lists image and video media_source
				// variants; generic document/GIF attachment types are not accepted.
				return {
					success: false,
					error: {
						code: "UNSUPPORTED_MEDIA_TYPE",
						message: "Pinterest pins support image or video attachments.",
					},
				};
			}
			if (videoCount > 1) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_VIDEOS",
						message: "Pinterest supports a maximum of 1 video per pin.",
					},
				};
			}
			if (videoCount === 0 && media.length > 5) {
				return {
					success: false,
					error: {
						code: "TOO_MANY_MEDIA",
						message: `Pinterest supports a maximum of 5 images per carousel pin. Got ${media.length}.`,
					},
				};
			}
			if (videoCount === 1 && media.length > 2) {
				return {
					success: false,
					error: {
						code: "INVALID_MEDIA_MIX",
						message:
							"Pinterest video pins support one video and one optional cover image.",
					},
				};
			}

			// Resolve title
			const title = (opts.title as string) ?? "";

			// Validate title length
			if (title.length > 100) {
				return {
					success: false,
					error: {
						code: "TITLE_TOO_LONG",
						message: `Pin title is ${title.length} characters. Pinterest limit is 100.`,
					},
				};
			}

			// Validate description length (Pinterest API v5 allows up to 800 characters)
			if (description.length > 800) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Pin description is ${description.length} characters. Pinterest limit is 800.`,
					},
				};
			}

			// Board ID
			const boardId =
				(opts.board_id as string | undefined) ??
				(request.account.metadata?.default_board_id as string | undefined);
			if (!boardId) {
				return {
					success: false,
					error: {
						code: "BOARD_REQUIRED",
						message:
							"Pinterest requires a board_id in target_options or the connected account's default_board_id.",
					},
				};
			}

			// Link (destination URL)
			const link = opts.link as string | undefined;

			// Build pin body — find the actual video item rather than assuming media[0]
			const videoItem = media.find((m) => m.type === "video");
			const imageItems = media.filter((m) => m.type !== "video");
			const isVideo = !!videoItem;
			const coverImageUrl =
				imageItems[0]?.url ?? (opts.cover_image_url as string | undefined);
			const rawCoverKeyFrameTime = opts.cover_image_key_frame_time;
			if (
				rawCoverKeyFrameTime !== undefined &&
				(typeof rawCoverKeyFrameTime !== "number" ||
					!Number.isSafeInteger(rawCoverKeyFrameTime) ||
					rawCoverKeyFrameTime < 0)
			) {
				return {
					success: false,
					error: {
						code: "CONTENT_ERROR",
						message:
							"Pinterest cover_image_key_frame_time must be a non-negative integer number of seconds.",
					},
				};
			}
			const coverKeyFrameTime = rawCoverKeyFrameTime as number | undefined;

			if (isVideo && !coverImageUrl && coverKeyFrameTime === undefined) {
				// Official guide: https://developers.pinterest.com/docs/work-with-organic-content-and-users/create-boards-and-pins/
				// Section "Step 4: Create Pin" warns that omitting a valid cover image
				// produces HTTP 400. The current OpenAPI source below additionally
				// documents a video key-frame cover, so accept either representation.
				// Official OpenAPI: https://github.com/pinterest/api-description/blob/main/v5/openapi.yaml
				// Schema `PinMediaSourceVideoID` fields: cover_image_url,
				// cover_image_data, and cover_image_key_frame_time.
				return {
					success: false,
					error: {
						code: "COVER_IMAGE_REQUIRED",
						message:
							"Pinterest video pins require an image attachment, target_options.cover_image_url, or target_options.cover_image_key_frame_time.",
					},
				};
			}

			const pinBody: Record<string, unknown> = {
				board_id: boardId,
				description,
			};

			if (title) {
				pinBody.title = title;
			}

			// Alt text for accessibility (max 500 chars)
			// Docs: https://developers.pinterest.com/docs/api/v5/pins-create/
			const altText = opts.alt_text as string | undefined;
			if (altText) {
				pinBody.alt_text = altText.slice(0, 500);
			}

			if (link) {
				pinBody.link = link;
			}

			// Media source
			if (isVideo) {
				// Pinterest video pins require a multi-step upload:
				// 1. POST /media with { media_type: "video" } → get media_id, upload_url, upload_parameters
				// 2. Upload the video binary to upload_url with upload_parameters
				// 3. Poll GET /media/{media_id} until status is "succeeded"
				// 4. Create pin with source_type: "video_id" and the media_id
				// https://developers.pinterest.com/docs/api/v5/media-create/

				// Step 1: Register media
				const registerRes = await pinterestFetch(
					`${PINTEREST_API}/media`,
					accessToken,
					{
						method: "POST",
						body: JSON.stringify({ media_type: "video" }),
					},
				);
				if (!registerRes.ok) {
					const err = await readPublisherJson(registerRes).catch(() => ({}));
					const raw = `HTTP ${registerRes.status}\n${JSON.stringify(err)}`;
					throw new PublishError(
						`Pinterest media register failed: ${(err as { message?: string }).message ?? registerRes.statusText}`,
						{ statusCode: registerRes.status, detail: raw },
					);
				}
				const registerData = (await readPublisherJson(registerRes)) as {
					media_id: string;
					upload_url: string;
					upload_parameters: Record<string, string>;
				};
				const mediaId = registerData.media_id;

				// Step 2: Download video then upload to Pinterest's upload_url
				const videoRes = await fetchPublicUrl(videoItem?.url ?? "", {
					timeout: 30_000,
				});
				if (!videoRes.ok) {
					throw new PublishError(
						`Failed to fetch video: ${videoRes.statusText}`,
						{
							statusCode: videoRes.status,
							detail: `HTTP ${videoRes.status} ${videoRes.statusText}`,
						},
					);
				}
				const multipart = await createStreamingMultipartBody(
					Object.entries(registerData.upload_parameters),
					{
						fieldName: "file",
						filename: "video",
						contentType: videoRes.headers.get("content-type") ?? "video/mp4",
						response: videoRes,
						maxBytes: PINTEREST_VIDEO_MAX_BYTES,
						refetch: () =>
							fetchPublicUrl(videoItem?.url ?? "", {
								timeout: 30_000,
								maxBytes: PINTEREST_VIDEO_MAX_BYTES,
							}),
					},
				);

				// Pinterest Media API — Upload video binary to the pre-signed URL
				// https://developers.pinterest.com/docs/api/v5/media-create/
				const uploadRes = await awaitResponseWithBodyCompletion(
					fetch(registerData.upload_url, {
						method: "POST",
						headers: {
							"Content-Type": multipart.contentType,
							"Content-Length": multipart.contentLength.toString(),
						},
						body: multipart.body,
					}),
					multipart.completion,
				);
				if (!uploadRes.ok) {
					throw new PublishError(
						`Pinterest video upload failed: ${uploadRes.statusText}`,
						{
							statusCode: uploadRes.status,
							detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
						},
					);
				}

				// Step 3: Poll for processing completion
				// Pinterest Media API — Check media processing status
				// https://developers.pinterest.com/docs/api/v5/media-get/
				const maxPollAttempts = 20;
				let videoReady = false;
				for (let i = 0; i < maxPollAttempts; i++) {
					await new Promise((r) => setTimeout(r, 15000));
					const statusRes = await pinterestFetch(
						`${PINTEREST_API}/media/${mediaId}`,
						accessToken,
					);
					if (!statusRes.ok) continue;
					const statusData = (await readPublisherJson(statusRes)) as {
						status: string;
					};
					if (statusData.status === "succeeded") {
						videoReady = true;
						break;
					}
					if (statusData.status === "failed") {
						throw new Error("Pinterest video processing failed");
					}
				}
				if (!videoReady) {
					throw new Error("Pinterest video processing timed out");
				}

				// Official OpenAPI `PinMediaSourceVideoID`: source_type + media_id are
				// required; URL and key-frame covers are both documented properties.
				const videoMediaSource: Record<string, unknown> = {
					source_type: "video_id",
					media_id: mediaId,
				};
				if (coverImageUrl) {
					videoMediaSource.cover_image_url = coverImageUrl;
				} else if (coverKeyFrameTime !== undefined) {
					videoMediaSource.cover_image_key_frame_time = coverKeyFrameTime;
				}
				pinBody.media_source = videoMediaSource;
			} else if (imageItems.length === 1) {
				// Single image pin
				pinBody.media_source = {
					source_type: "image_url",
					url: imageItems[0]?.url,
				};
			} else {
				// Carousel pin: 2-5 images using multiple_image_urls source type
				// https://developers.pinterest.com/docs/api/v5/pins-create/
				pinBody.media_source = {
					source_type: "multiple_image_urls",
					items: imageItems.map((m) => ({
						url: m.url,
					})),
				};
			}

			// Pinterest Pins API — Create a pin
			// https://developers.pinterest.com/docs/api/v5/pins-create/
			const res = await pinterestFetch(`${PINTEREST_API}/pins`, accessToken, {
				method: "POST",
				body: JSON.stringify(pinBody),
			});

			if (!res.ok) {
				const err = await readPublisherJson(res).catch(() => ({}));
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				const detail = (err as { message?: string }).message ?? res.statusText;
				throw new PublishError(`Pinterest pin creation failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}

			const result = (await readPublisherJson(res)) as {
				id?: string;
				link?: string;
			};

			const pinId = result.id;
			const pinUrl = pinId
				? `https://www.pinterest.com/pin/${pinId}/`
				: undefined;

			return {
				success: true,
				platform_post_id: pinId,
				platform_url: pinUrl,
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
