import { GRAPH_BASE } from "../config/api-versions";
import {
	awaitResponseWithBodyCompletion,
	ensureResponseContentLength,
	fetchPublicUrl,
	getFixedLengthResponseBody,
} from "../lib/fetch-public-url";
import { FacebookTargetOptions } from "../schemas/publisher-options";
import { readPublisherJson, readPublisherText } from "./provider-response";
import {
	classifyPublishError,
	type EngagementAccount,
	type EngagementActionResult,
	getSucceededProviderEffect,
	PublishError,
	type Publisher,
	type PublishRequest,
	type PublishResult,
	type ReconcileRequest,
	recordProviderEffect,
} from "./types";

const GRAPH_API = GRAPH_BASE.facebook;
// RelayAPI defensive streaming ceiling. Meta's Page Stories developer reference
// specifies video duration/format but does not publish a general 4 GB API limit.
const FACEBOOK_STREAM_UPLOAD_MAX_BYTES = 4_000_000_000;

interface FacebookAuth {
	access_token: string;
	page_id: string;
}

async function graphFetch(
	url: string,
	auth: FacebookAuth,
	options: RequestInit = {},
): Promise<Response> {
	const separator = url.includes("?") ? "&" : "?";
	return fetch(`${url}${separator}access_token=${auth.access_token}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...(options.headers ?? {}),
		},
	});
}

async function graphPost(
	endpoint: string,
	auth: FacebookAuth,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await graphFetch(`${GRAPH_API}${endpoint}`, auth, {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: { message?: string; code?: number; error_subcode?: number };
		};
		const detail = err.error?.message ?? res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		const fbCode = err.error?.code;
		const subcode = err.error?.error_subcode;

		// Classify Facebook-specific errors for retry/refresh decisions
		// Docs: https://developers.facebook.com/docs/graph-api/guides/error-handling
		if (
			detail.includes("Error validating access token") ||
			detail.includes("REVOKED_ACCESS_TOKEN") ||
			subcode === 490 ||
			subcode === 463 ||
			subcode === 464 ||
			subcode === 467 ||
			fbCode === 190
		) {
			throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (subcode === 1390008 || fbCode === 32 || fbCode === 4 || fbCode === 17) {
			throw new PublishError(`RATE_LIMITED: ${detail}`, {
				statusCode: res.status,
				detail: raw,
			});
		}
		if (fbCode === 368) {
			throw new PublishError(
				`PLATFORM_ERROR: Temporarily blocked — ${detail}`,
				{ statusCode: res.status, detail: raw },
			);
		}
		throw new PublishError(`Facebook API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	return readPublisherJson(res) as Promise<Record<string, unknown>>;
}

/**
 * Create a text-only feed post.
 */
async function createTextPost(
	auth: FacebookAuth,
	message: string,
	feedOptions: Record<string, unknown> = {},
): Promise<{ id: string; permalink_url?: string }> {
	// Facebook Graph API: Create page feed post (read-after-write for permalink_url)
	// Docs: https://developers.facebook.com/docs/pages-api/posts
	const result = await graphPost(
		`/${auth.page_id}/feed?fields=id,permalink_url`,
		auth,
		{ message, ...feedOptions },
	);
	return {
		id: result.id as string,
		permalink_url: result.permalink_url as string | undefined,
	};
}

/**
 * Upload a single photo. When `published` is false the photo is staged
 * for inclusion in a multi-image post.
 */
async function uploadPhoto(
	auth: FacebookAuth,
	imageUrl: string,
	message?: string,
	published = true,
): Promise<{ id: string; post_id?: string }> {
	const body: Record<string, unknown> = {
		url: imageUrl,
		published,
	};
	if (message) {
		body.caption = message;
	}

	// Facebook Graph API: Upload photo to page
	// Docs: https://developers.facebook.com/docs/graph-api/reference/page/photos/
	const result = await graphPost(`/${auth.page_id}/photos`, auth, body);
	return {
		id: result.id as string,
		post_id: result.post_id as string | undefined,
	};
}

/**
 * Publish a multi-image post. Uploads each image unpublished, then creates
 * a feed post referencing all of them.
 */
async function createMultiImagePost(
	request: PublishRequest,
	auth: FacebookAuth,
	imageUrls: string[],
	message?: string,
	feedOptions: Record<string, unknown> = {},
): Promise<{ id: string; permalink_url?: string }> {
	const published = getSucceededProviderEffect(request, "post_published");
	if (published?.provider_id) return { id: published.provider_id };
	// Upload each image as unpublished and journal it before creating another.
	const uploads: Array<{ id: string }> = [];
	for (const [index, url] of imageUrls.entries()) {
		const effectName = `staged_photo_${index + 1}`;
		let photoId = getSucceededProviderEffect(request, effectName)?.provider_id;
		if (!photoId) {
			const uploaded = await uploadPhoto(auth, url, undefined, false);
			photoId = uploaded.id;
			await recordProviderEffect(request, {
				name: effectName,
				status: "succeeded",
				provider_id: photoId,
			});
		}
		uploads.push({ id: photoId });
	}

	// Create feed post with attached_media using indexed URL-encoded format
	// Facebook requires attached_media[0]=..., attached_media[1]=... format
	// JSON arrays are fragile and cause "(#100) param attached_media must be an array" errors
	// Docs: https://developers.facebook.com/docs/pages-api/posts
	const params = new URLSearchParams();
	params.append("access_token", auth.access_token);
	if (message) {
		params.append("message", message);
	}
	for (const [key, value] of Object.entries(feedOptions)) {
		params.append(
			key,
			typeof value === "object" && value !== null
				? JSON.stringify(value)
				: String(value),
		);
	}
	for (const [i, upload] of uploads.entries()) {
		params.append(
			`attached_media[${i}]`,
			JSON.stringify({ media_fbid: upload.id }),
		);
	}

	const res = await fetch(
		`${GRAPH_API}/${auth.page_id}/feed?fields=id,permalink_url`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		},
	);

	if (!res.ok) {
		const err = (await readPublisherJson(res).catch(() => ({}))) as {
			error?: { message?: string };
		};
		const detail = err.error?.message ?? res.statusText;
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(`Facebook API error: ${detail}`, {
			statusCode: res.status,
			detail: raw,
		});
	}

	const result = (await readPublisherJson(res)) as Record<string, unknown>;
	await recordProviderEffect(request, {
		name: "post_published",
		status: "succeeded",
		provider_id: result.id as string,
	});
	return {
		id: result.id as string,
		permalink_url: result.permalink_url as string | undefined,
	};
}

/**
 * Upload and publish a video post.
 */
async function createVideoPost(
	auth: FacebookAuth,
	videoUrl: string,
	description?: string,
	videoOptions: Record<string, unknown> = {},
): Promise<{ id: string; permalink_url?: string }> {
	const body: Record<string, unknown> = {
		file_url: videoUrl,
		...videoOptions,
	};
	if (description) {
		body.description = description;
	}

	// Facebook Graph API: Upload and publish video to page via file_url
	// https://developers.facebook.com/docs/graph-api/reference/page/videos/
	const result = await graphPost(
		`/${auth.page_id}/videos?fields=id,permalink_url`,
		auth,
		body,
	);
	return {
		id: result.id as string,
		permalink_url: result.permalink_url as string | undefined,
	};
}

/**
 * Publish a photo story.
 * 1. Upload photo as unpublished to get photo_id
 * 2. Create photo story using the photo_id
 * https://developers.facebook.com/docs/pages-api/posts
 */
async function createPhotoStory(
	request: PublishRequest,
	auth: FacebookAuth,
	imageUrl: string,
): Promise<{ id: string }> {
	const published = getSucceededProviderEffect(request, "post_published");
	if (published?.provider_id) return { id: published.provider_id };
	// Step 1: Upload photo as unpublished
	let photoId = getSucceededProviderEffect(
		request,
		"staged_photo",
	)?.provider_id;
	if (!photoId) {
		const photo = await uploadPhoto(auth, imageUrl, undefined, false);
		photoId = photo.id;
		await recordProviderEffect(request, {
			name: "staged_photo",
			status: "succeeded",
			provider_id: photoId,
		});
	}

	// Step 2: Create photo story using photo_id
	const result = await graphPost(`/${auth.page_id}/photo_stories`, auth, {
		photo_id: photoId,
	});
	const postId = (result.post_id as string) ?? (result.id as string);
	await recordProviderEffect(request, {
		name: "post_published",
		status: "succeeded",
		provider_id: postId,
	});
	return { id: postId };
}

/**
 * Publish a video story using the multi-step upload flow:
 * 1. POST /{page-id}/video_stories with upload_phase=start → get video_id + upload_url
 * 2. POST video binary to the upload_url
 * 3. POST /{page-id}/video_stories with upload_phase=finish + video_id
 * https://developers.facebook.com/docs/pages-api/posts
 */
async function createVideoStory(
	request: PublishRequest,
	auth: FacebookAuth,
	videoUrl: string,
): Promise<{ operationId: string; postId?: string }> {
	const finished = getSucceededProviderEffect(request, "video_finish_accepted");
	if (finished?.provider_id) {
		return {
			operationId: finished.provider_id,
			postId: getSucceededProviderEffect(request, "post_published")
				?.provider_id,
		};
	}
	const uploaded = getSucceededProviderEffect(request, "video_binary_uploaded");
	let videoId = uploaded?.provider_id;
	let uploadUrl: string | undefined;
	// Step 1: Start upload
	if (!videoId) {
		const started = getSucceededProviderEffect(request, "video_upload_started");
		if (started) {
			throw new PublishError(
				"Facebook video story upload was started, but its upload URL cannot be safely reconstructed. Reconcile the recorded video operation instead of recreating it.",
				{ code: "PUBLISH_OUTCOME_UNKNOWN" },
			);
		}
		const startResult = await graphPost(
			`/${auth.page_id}/video_stories`,
			auth,
			{
				upload_phase: "start",
			},
		);
		videoId = startResult.video_id as string;
		uploadUrl = startResult.upload_url as string;
		await recordProviderEffect(request, {
			name: "video_upload_started",
			status: "succeeded",
			provider_id: videoId,
		});
	}

	// Step 2: Upload binary to the upload_url
	if (!uploaded) {
		if (!uploadUrl) throw new Error("Facebook video story upload URL missing.");
		const videoRes = await fetchPublicUrl(videoUrl, { timeout: 30_000 });
		if (!videoRes.ok) {
			throw new PublishError(
				`Failed to fetch story video from ${videoUrl}: ${videoRes.statusText}`,
				{
					statusCode: videoRes.status,
					detail: `HTTP ${videoRes.status} ${videoRes.statusText}`,
				},
			);
		}
		const preparedVideoRes = await ensureResponseContentLength(
			videoRes,
			FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
			() =>
				fetchPublicUrl(videoUrl, {
					timeout: 30_000,
					maxBytes: FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
				}),
		);
		const source = getFixedLengthResponseBody(
			preparedVideoRes,
			FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
		);

		const uploadRes = await awaitResponseWithBodyCompletion(
			fetch(uploadUrl, {
				method: "POST",
				headers: {
					Authorization: `OAuth ${auth.access_token}`,
					"Content-Type": "application/octet-stream",
					file_size: source.contentLength.toString(),
					offset: "0",
				},
				body: source.body,
			}),
			source.completion,
		);
		if (!uploadRes.ok) {
			throw new PublishError(
				`Facebook video story upload failed: ${uploadRes.statusText}`,
				{
					statusCode: uploadRes.status,
					detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
				},
			);
		}
		await recordProviderEffect(request, {
			name: "video_binary_uploaded",
			status: "succeeded",
			provider_id: videoId,
		});
	}
	// Step 3: Finish upload
	const finishResult = await graphPost(`/${auth.page_id}/video_stories`, auth, {
		upload_phase: "finish",
		video_id: videoId,
	});
	await recordProviderEffect(request, {
		name: "video_finish_accepted",
		status: "succeeded",
		provider_id: videoId,
	});
	const postId =
		(finishResult.post_id as string | undefined) ??
		(finishResult.id as string | undefined);
	if (postId) {
		await recordProviderEffect(request, {
			name: "post_published",
			status: "succeeded",
			provider_id: postId,
		});
	}
	return {
		operationId: videoId,
		postId,
	};
}

/**
 * Publish a Reel using the two-phase upload flow:
 * 1. POST /{page-id}/video_reels with upload_phase=start
 * 2. PUT the video binary to the returned upload_url
 * 3. POST /{page-id}/video_reels with upload_phase=finish
 */
async function createReel(
	request: PublishRequest,
	auth: FacebookAuth,
	videoUrl: string,
	description?: string,
	title?: string,
	videoState: "DRAFT" | "SCHEDULED" | "PUBLISHED" = "PUBLISHED",
	scheduledPublishTime?: number,
	placeId?: string,
): Promise<{ operationId: string; postId?: string }> {
	const finished = getSucceededProviderEffect(request, "video_finish_accepted");
	if (finished?.provider_id) {
		return {
			operationId: finished.provider_id,
			postId: getSucceededProviderEffect(request, "post_published")
				?.provider_id,
		};
	}
	const uploaded = getSucceededProviderEffect(request, "video_binary_uploaded");
	let videoId = uploaded?.provider_id;
	let uploadUrl: string | undefined;
	// Facebook Graph API: Start reel upload (phase 1)
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	if (!videoId) {
		const started = getSucceededProviderEffect(request, "video_upload_started");
		if (started) {
			throw new PublishError(
				"Facebook Reel upload was started, but its upload URL cannot be safely reconstructed. Reconcile the recorded video operation instead of recreating it.",
				{ code: "PUBLISH_OUTCOME_UNKNOWN" },
			);
		}
		const startResult = await graphPost(`/${auth.page_id}/video_reels`, auth, {
			upload_phase: "start",
		});
		videoId = startResult.video_id as string;
		uploadUrl = startResult.upload_url as string;
		await recordProviderEffect(request, {
			name: "video_upload_started",
			status: "succeeded",
			provider_id: videoId,
		});
	}

	// Fetch the video binary from source URL
	if (!uploaded && !uploadUrl)
		throw new Error("Facebook Reel upload URL missing.");
	const videoRes = uploaded
		? null
		: await fetchPublicUrl(videoUrl, { timeout: 30_000 });
	if (videoRes && !videoRes.ok) {
		throw new PublishError(
			`Failed to fetch reel video from ${videoUrl}: ${videoRes.statusText}`,
			{
				statusCode: videoRes.status,
				detail: `HTTP ${videoRes.status} ${videoRes.statusText}`,
			},
		);
	}
	const preparedVideoRes = videoRes
		? await ensureResponseContentLength(
				videoRes,
				FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
				() =>
					fetchPublicUrl(videoUrl, {
						timeout: 30_000,
						maxBytes: FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
					}),
			)
		: null;
	const source = preparedVideoRes
		? getFixedLengthResponseBody(
				preparedVideoRes,
				FACEBOOK_STREAM_UPLOAD_MAX_BYTES,
			)
		: null;

	// Facebook Graph API: Upload reel video binary (phase 2)
	// Method must be POST, Content-Type must be application/octet-stream, offset header required
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	const uploadRes = source
		? await awaitResponseWithBodyCompletion(
				fetch(uploadUrl as string, {
					method: "POST",
					headers: {
						Authorization: `OAuth ${auth.access_token}`,
						"Content-Type": "application/octet-stream",
						offset: "0",
						file_size: source.contentLength.toString(),
					},
					body: source.body,
				}),
				source.completion,
			)
		: null;
	if (uploadRes && !uploadRes.ok) {
		throw new PublishError(
			`Facebook reel upload failed: ${uploadRes.statusText}`,
			{
				statusCode: uploadRes.status,
				detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
			},
		);
	}
	if (uploadRes) {
		await recordProviderEffect(request, {
			name: "video_binary_uploaded",
			status: "succeeded",
			provider_id: videoId,
		});
	}
	// Facebook Graph API: Finish reel upload (phase 3)
	// Official Reels Publishing guide, section "Publish a Reel":
	// https://developers.facebook.com/docs/video-api/guides/reels-publishing
	// video_state is DRAFT, SCHEDULED, or PUBLISHED; a scheduled Reel also uses
	// scheduled_publish_time (Unix seconds), and location tagging uses place.
	// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
	const finishBody: Record<string, unknown> = {
		upload_phase: "finish",
		video_id: videoId,
		video_state: videoState,
	};
	if (description) {
		finishBody.description = description;
	}
	if (title) {
		finishBody.title = title;
	}
	if (scheduledPublishTime !== undefined) {
		finishBody.scheduled_publish_time = scheduledPublishTime;
	}
	if (placeId) {
		finishBody.place = placeId;
	}

	const finishResult = await graphPost(
		`/${auth.page_id}/video_reels`,
		auth,
		finishBody,
	);
	await recordProviderEffect(request, {
		name: "video_finish_accepted",
		status: "succeeded",
		provider_id: videoId,
	});
	const postId = finishResult.post_id as string | undefined;
	if (postId) {
		await recordProviderEffect(request, {
			name: "post_published",
			status: "succeeded",
			provider_id: postId,
		});
	}
	return {
		operationId: videoId,
		postId,
	};
}

/**
 * Post a comment on a published post.
 */
async function postFirstComment(
	auth: FacebookAuth,
	postId: string,
	message: string,
): Promise<string> {
	// Facebook Graph API: Post a comment on a published object
	// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
	const result = await graphPost(`/${postId}/comments`, auth, { message });
	return result.id as string;
}

async function publishFirstCommentOnce(
	request: PublishRequest,
	auth: FacebookAuth,
	postId: string,
	message: string,
): Promise<void> {
	if (getSucceededProviderEffect(request, "first_comment")) return;
	let commentId: string;
	try {
		commentId = await postFirstComment(auth, postId, message);
	} catch {
		return;
	}
	await recordProviderEffect(request, {
		name: "first_comment",
		status: "succeeded",
		provider_id: commentId,
	});
}

export const facebookPublisher: Publisher = {
	platform: "facebook",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		const operationId = request.provider_operation_id?.trim();
		if (!operationId) {
			return {
				success: false,
				provider_outcome: { disposition: "outcome_unknown" },
				error: {
					code: "MISSING_PROVIDER_OPERATION_ID",
					message:
						"Facebook video reconciliation requires the original video ID.",
				},
			};
		}

		try {
			const auth: FacebookAuth = {
				access_token: request.account.access_token,
				page_id: request.account.platform_account_id,
			};
			// Meta's video status endpoint exposes phase-level processing state.
			// https://developers.facebook.com/docs/graph-api/reference/video/
			// Section: Reading, fields `status` and `permalink_url`.
			const res = await graphFetch(
				`${GRAPH_API}/${encodeURIComponent(operationId)}?fields=status,permalink_url`,
				auth,
			);
			if (!res.ok) {
				const raw = await readPublisherText(res).catch(() => res.statusText);
				throw new PublishError(
					`Facebook video status failed: ${res.statusText}`,
					{
						statusCode: res.status,
						detail: `HTTP ${res.status}\n${raw}`,
					},
				);
			}
			const data = (await readPublisherJson(res)) as {
				id?: string;
				permalink_url?: string;
				status?: {
					video_status?: string;
					uploading_phase?: { status?: string; errors?: unknown[] };
					processing_phase?: { status?: string; errors?: unknown[] };
					publishing_phase?: { status?: string; errors?: unknown[] };
				};
			};
			const status = data.status;
			const phaseStates = [
				status?.uploading_phase?.status,
				status?.processing_phase?.status,
				status?.publishing_phase?.status,
			]
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.toLowerCase());
			const videoState = status?.video_status?.toLowerCase();
			const hasErrors = [
				status?.uploading_phase?.errors,
				status?.processing_phase?.errors,
				status?.publishing_phase?.errors,
			].some((errors) => Array.isArray(errors) && errors.length > 0);
			const isFailed =
				hasErrors ||
				videoState === "error" ||
				videoState === "failed" ||
				phaseStates.some((state) => state === "error" || state === "failed");
			const providerState =
				status?.video_status ??
				phaseStates.at(-1) ??
				request.provider_state ??
				"missing_status";

			if (isFailed) {
				return {
					success: false,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: operationId,
						platform_post_id: request.platform_post_id ?? undefined,
						provider_state: providerState,
					},
					error: {
						code: "FACEBOOK_VIDEO_FAILED",
						message: "Facebook failed to process or publish the video.",
					},
				};
			}

			const isReady =
				videoState === "ready" ||
				videoState === "published" ||
				status?.publishing_phase?.status?.toLowerCase() === "complete";
			if (isReady) {
				const postId =
					request.platform_post_id?.trim() || data.id || operationId;
				return {
					success: true,
					platform_post_id: postId,
					platform_url: data.permalink_url,
					provider_outcome: {
						disposition: "published",
						provider_operation_id: operationId,
						platform_post_id: postId,
						platform_url: data.permalink_url,
						provider_state: providerState,
					},
				};
			}

			return {
				success: true,
				platform_post_id: request.platform_post_id ?? undefined,
				provider_outcome: {
					disposition: "processing",
					provider_operation_id: operationId,
					platform_post_id: request.platform_post_id ?? undefined,
					provider_state: providerState,
				},
			};
		} catch (error) {
			const result = classifyPublishError(error);
			return {
				...result,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_operation_id: operationId,
					platform_post_id: request.platform_post_id ?? undefined,
					provider_state: request.provider_state ?? undefined,
				},
			};
		}
	},

	async comment(
		account: EngagementAccount,
		platformPostId: string,
		text: string,
	): Promise<EngagementActionResult> {
		try {
			const auth: FacebookAuth = {
				access_token: account.access_token,
				page_id: account.platform_account_id,
			};
			// Facebook Graph API: Post a comment on a published object
			// Docs: https://developers.facebook.com/docs/graph-api/reference/object/comments/
			const result = await graphPost(`/${platformPostId}/comments`, auth, {
				message: text,
			});
			return { success: true, platform_post_id: result.id as string };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const parsedOptions = FacebookTargetOptions.safeParse(
				request.target_options,
			);
			if (!parsedOptions.success) {
				const issue = parsedOptions.error.issues[0];
				const path = issue?.path.length ? ` ${issue.path.join(".")}` : "";
				return {
					success: false,
					error: {
						code: "INVALID_FACEBOOK_TARGET_OPTIONS",
						message: `Invalid Facebook target option${path}: ${issue?.message ?? "validation failed"}.`,
					},
				};
			}
			const opts = parsedOptions.data;
			const pageId = request.account.platform_account_id;
			if (
				typeof opts.page_id === "string" &&
				opts.page_id.trim() &&
				opts.page_id.trim() !== pageId
			) {
				return {
					success: false,
					error: {
						code: "PAGE_ID_MISMATCH",
						message:
							"target_options.page_id does not match the connected Facebook Page.",
					},
				};
			}
			const auth: FacebookAuth = {
				access_token: request.account.access_token,
				page_id: pageId,
			};

			const content = (opts.content as string) ?? request.content ?? "";
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;
			const contentType = opts.content_type as string | undefined;
			const firstComment = opts.first_comment as string | undefined;
			const title = opts.title as string | undefined;
			const isFeed = contentType === undefined || contentType === "feed";
			const published = opts.published as boolean | undefined;
			const placeId =
				typeof opts.place_id === "string" && opts.place_id.trim()
					? opts.place_id.trim()
					: undefined;
			const targeting = opts.targeting;
			const feedTargeting = opts.feed_targeting;
			const reelState = (opts.reel_state ?? "PUBLISHED") as unknown;
			const reelScheduledAt = opts.reel_scheduled_publish_time;
			if (opts.place_id !== undefined && !/^\d+$/.test(placeId ?? "")) {
				return {
					success: false,
					error: {
						code: "INVALID_PLACE_ID",
						message: "Facebook place_id must be a numeric Graph object ID.",
					},
				};
			}

			if (published !== undefined && typeof published !== "boolean") {
				return {
					success: false,
					error: {
						code: "INVALID_PUBLISHED_OPTION",
						message: "Facebook published must be boolean.",
					},
				};
			}
			if (published !== undefined && !isFeed) {
				return {
					success: false,
					error: {
						code: "FACEBOOK_OPTION_REQUIRES_FEED",
						message: "Facebook published is supported only for feed posts.",
					},
				};
			}
			if ((targeting !== undefined || feedTargeting !== undefined) && !isFeed) {
				return {
					success: false,
					error: {
						code: "FACEBOOK_OPTION_REQUIRES_FEED",
						message:
							"Facebook targeting and feed_targeting are supported only for feed posts.",
					},
				};
			}
			if (placeId && contentType === "story") {
				return {
					success: false,
					error: {
						code: "FACEBOOK_OPTION_UNSUPPORTED_FOR_STORY",
						message:
							"Facebook place_id is supported for feed posts and Reels, not Stories.",
					},
				};
			}
			for (const [name, value] of [
				["targeting", targeting],
				["feed_targeting", feedTargeting],
			] as const) {
				if (
					value !== undefined &&
					(!value || typeof value !== "object" || Array.isArray(value))
				) {
					return {
						success: false,
						error: {
							code: "INVALID_FACEBOOK_TARGETING",
							message: `Facebook ${name} must be an object.`,
						},
					};
				}
			}
			if (published === false && firstComment) {
				return {
					success: false,
					error: {
						code: "FIRST_COMMENT_REQUIRES_PUBLISHED_POST",
						message:
							"Facebook first_comment cannot be added to an unpublished post.",
					},
				};
			}
			if (firstComment && !isFeed) {
				return {
					success: false,
					error: {
						code: "FACEBOOK_OPTION_REQUIRES_FEED",
						message: "Facebook first_comment is supported only for feed posts.",
					},
				};
			}
			if (
				reelState !== "DRAFT" &&
				reelState !== "SCHEDULED" &&
				reelState !== "PUBLISHED"
			) {
				return {
					success: false,
					error: {
						code: "INVALID_REEL_STATE",
						message:
							"Facebook reel_state must be DRAFT, SCHEDULED, or PUBLISHED.",
					},
				};
			}
			if (opts.reel_state !== undefined && contentType !== "reel") {
				return {
					success: false,
					error: {
						code: "FACEBOOK_OPTION_REQUIRES_REEL",
						message: "Facebook reel_state is supported only for Reel posts.",
					},
				};
			}
			let reelScheduledPublishSeconds: number | undefined;
			if (reelState === "SCHEDULED") {
				if (typeof reelScheduledAt !== "string") {
					return {
						success: false,
						error: {
							code: "INVALID_REEL_SCHEDULE",
							message:
								"Facebook reel_state SCHEDULED requires reel_scheduled_publish_time.",
						},
					};
				}
				const scheduledMs = Date.parse(reelScheduledAt);
				const now = Date.now();
				if (
					!Number.isFinite(scheduledMs) ||
					scheduledMs <= now + 10 * 60 * 1000 ||
					scheduledMs > now + 29 * 24 * 60 * 60 * 1000
				) {
					return {
						success: false,
						error: {
							code: "INVALID_REEL_SCHEDULE",
							message:
								"Facebook Reel scheduling must be more than 10 minutes and no more than 29 days in the future.",
						},
					};
				}
				reelScheduledPublishSeconds = Math.floor(scheduledMs / 1000);
			} else if (reelScheduledAt !== undefined) {
				return {
					success: false,
					error: {
						code: "INVALID_REEL_SCHEDULE",
						message:
							"Facebook reel_scheduled_publish_time requires reel_state SCHEDULED.",
					},
				};
			}

			// Official Page posts reference: published=false creates an unpublished
			// post; targeting is strict, feed_targeting is preferential, and place is
			// the location Page ID. https://developers.facebook.com/docs/pages-api/posts
			const feedOptions: Record<string, unknown> = {};
			if (published !== undefined) feedOptions.published = published;
			if (placeId) feedOptions.place = placeId;
			if (targeting !== undefined) feedOptions.targeting = targeting;
			if (feedTargeting !== undefined)
				feedOptions.feed_targeting = feedTargeting;

			let postId: string;
			let permalinkUrl: string | undefined;

			// Determine content type
			if (contentType === "story") {
				// Story — requires exactly one media item
				if (media.length !== 1) {
					// Official docs: https://developers.facebook.com/docs/page-stories-api
					// Sections "Photo stories" and "Video stories" use
					// `/{page-id}/photo_stories` and `/{page-id}/video_stories` and
					// create one story from one photo_id or one video upload session.
					return {
						success: false,
						error: {
							code: media.length === 0 ? "MEDIA_REQUIRED" : "TOO_MANY_MEDIA",
							message: "Facebook stories require exactly one media attachment.",
						},
					};
				}

				const firstMedia = media[0];
				if (!firstMedia) throw new Error("No media found");
				if (firstMedia.type === "video") {
					const result = await createVideoStory(request, auth, firstMedia.url);
					return {
						success: true,
						platform_post_id: result.postId,
						platform_url: `https://www.facebook.com/${pageId}`,
						provider_outcome: {
							disposition: "processing",
							provider_operation_id: result.operationId,
							platform_post_id: result.postId,
							platform_url: `https://www.facebook.com/${pageId}`,
							provider_state: "video_story_finish_accepted",
						},
					};
				} else {
					const result = await createPhotoStory(request, auth, firstMedia.url);
					postId = result.id;
				}
				if (!postId?.trim()) {
					throw new Error(
						"Facebook photo story response did not include a post ID.",
					);
				}

				return {
					success: true,
					platform_post_id: postId,
					platform_url: `https://www.facebook.com/${pageId}`,
					provider_outcome: {
						disposition: "published",
						platform_post_id: postId,
						platform_url: `https://www.facebook.com/${pageId}`,
						provider_state: "created",
					},
				};
			}

			if (contentType === "reel") {
				// Reel — requires exactly one video
				if (media.length !== 1 || media[0]?.type !== "video") {
					// Official docs: https://developers.facebook.com/documentation/video-api/guides/reels-publishing
					// Sections "Create a Reel" through "Publish a Reel" use one
					// video_id/upload session for each published Reel.
					return {
						success: false,
						error: {
							code: "VIDEO_REQUIRED",
							message: "Facebook reels require exactly one video attachment.",
						},
					};
				}

				const result = await createReel(
					request,
					auth,
					media[0]?.url,
					content || undefined,
					title,
					reelState,
					reelScheduledPublishSeconds,
					placeId,
				);
				const reelDisposition =
					reelState === "DRAFT"
						? "provider_draft"
						: reelState === "SCHEDULED"
							? "scheduled"
							: "processing";
				const reelUrl =
					reelState === "PUBLISHED" && result.postId
						? `https://www.facebook.com/reel/${result.postId}`
						: undefined;

				return {
					success: true,
					platform_post_id: result.postId,
					platform_url: reelUrl,
					provider_outcome: {
						disposition: reelDisposition,
						provider_operation_id: result.operationId,
						platform_post_id: result.postId,
						platform_url: reelUrl,
						provider_state: `reel_${reelState.toLowerCase()}`,
						next_reconcile_at:
							reelState === "SCHEDULED" && typeof reelScheduledAt === "string"
								? reelScheduledAt
								: undefined,
					},
				};
			}

			// Feed post
			const images = media.filter(
				(m) => !m.type || m.type === "image" || m.type === "gif",
			);
			const videos = media.filter((m) => m.type === "video");

			if (images.length > 0 && videos.length > 0) {
				return {
					success: false,
					error: {
						code: "INVALID_MEDIA",
						message:
							"Facebook does not allow mixing images and videos in the same post.",
					},
				};
			}
			if (videos.length > 0 && placeId) {
				return {
					success: false,
					error: {
						code: "PLACE_UNSUPPORTED_FOR_VIDEO_FEED",
						message:
							"Facebook's Page video endpoint does not support place; use a text, image, or Reel post.",
					},
				};
			}

			if (videos.length > 0) {
				// Video post (single video only)
				if (videos.length > 1) {
					// Official docs: https://developers.facebook.com/docs/graph-api/reference/page/videos/
					// The Page `videos` POST creates one Video from one `file_url`.
					return {
						success: false,
						error: {
							code: "TOO_MANY_VIDEOS",
							message: "Facebook feed video posts support one video.",
						},
					};
				}
				const recorded = getSucceededProviderEffect(request, "post_published");
				if (recorded?.provider_id) {
					postId = recorded.provider_id;
				} else {
					const result = await createVideoPost(
						auth,
						videos[0]?.url ?? "",
						content || undefined,
						Object.fromEntries(
							Object.entries(feedOptions).filter(([key]) => key !== "place"),
						),
					);
					postId = result.id;
					permalinkUrl = result.permalink_url;
					await recordProviderEffect(request, {
						name: "post_published",
						status: "succeeded",
						provider_id: postId,
					});
				}
			} else if (images.length > 1) {
				// Multi-image post
				const result = await createMultiImagePost(
					request,
					auth,
					images.map((m) => m.url),
					content || undefined,
					feedOptions,
				);
				postId = result.id;
				permalinkUrl = result.permalink_url;
			} else if (images.length === 1) {
				// Stage the image then create the authoritative /feed object so the
				// documented published/place/targeting fields apply consistently.
				const result = await createMultiImagePost(
					request,
					auth,
					[images[0]?.url ?? ""],
					content || undefined,
					feedOptions,
				);
				postId = result.id;
				permalinkUrl = result.permalink_url;
			} else {
				// Text-only post
				if (!content) {
					return {
						success: false,
						error: {
							code: "CONTENT_REQUIRED",
							message: "Facebook text posts require content.",
						},
					};
				}
				const recorded = getSucceededProviderEffect(request, "post_published");
				if (recorded?.provider_id) {
					postId = recorded.provider_id;
				} else {
					const result = await createTextPost(auth, content, feedOptions);
					postId = result.id;
					permalinkUrl = result.permalink_url;
					await recordProviderEffect(request, {
						name: "post_published",
						status: "succeeded",
						provider_id: postId,
					});
				}
			}

			// First comment (feed posts only)
			if (firstComment && published !== false)
				await publishFirstCommentOnce(request, auth, postId, firstComment);
			if (!postId?.trim()) {
				throw new Error("Facebook response did not include a post ID.");
			}

			// Use permalink_url from API response when available, fall back to constructed URL
			// Post IDs are typically PAGEID_POSTID format
			const parts = postId.split("_");
			const fallbackUrl =
				parts.length === 2
					? `https://www.facebook.com/${parts[0]}/posts/${parts[1]}`
					: `https://www.facebook.com/${auth.page_id}/posts/${postId}`;
			const platformUrl =
				published === false ? undefined : (permalinkUrl ?? fallbackUrl);
			const feedDisposition =
				published === false
					? "provider_draft"
					: videos.length > 0
						? "processing"
						: "published";

			return {
				success: true,
				platform_post_id: postId,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: feedDisposition,
					provider_operation_id: videos.length > 0 ? postId : undefined,
					platform_post_id: postId,
					platform_url: platformUrl,
					provider_state:
						published === false
							? "unpublished"
							: videos.length > 0
								? "video_upload_accepted"
								: "created",
				},
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
