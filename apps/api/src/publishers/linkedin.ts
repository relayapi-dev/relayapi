import {
	awaitResponseWithBodyCompletion,
	ensureResponseContentLength,
	fetchPublicUrl,
	getChunkedResponseBody,
	getFixedLengthResponseBody,
	parseContentLength,
} from "../lib/fetch-public-url";
import {
	getLinkedInRestHeaders,
	LINKEDIN_API_BASE,
} from "../lib/linkedin-rest";
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
	type ReconcileRequest,
	recordProviderEffect,
} from "./types";

const CHARACTER_LIMIT = 3000;
// RelayAPI defensive streaming ceiling; the Images API publishes formats and
// GIF frame limits but currently provides no image byte ceiling.
const LINKEDIN_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
// LinkedIn Documents API: file size cannot exceed 100 MB.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api
const LINKEDIN_DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
// Videos API > "Video File Size Specifications" says 75 KB to 500 MB. The
// initialize schema separately accepts a byte count up to 5 GB; use the stricter
// published file specification to avoid uploads that pass init but fail later.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
const LINKEDIN_VIDEO_MAX_BYTES = 500_000_000;
const LINKEDIN_VIDEO_PART_MAX_BYTES = 4 * 1024 * 1024;

interface LinkedInAuth {
	access_token: string;
}

async function linkedinFetch(
	url: string,
	auth: LinkedInAuth,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: getLinkedInRestHeaders(auth.access_token, {
			"Content-Type": "application/json",
			...(options.headers as Record<string, string> | undefined),
		}),
	});
	// Classify HTTP-level errors that apply to all LinkedIn API calls
	if (res.status === 401)
		throw new PublishError(`TOKEN_EXPIRED: LinkedIn token expired or invalid`, {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	if (res.status === 429)
		throw new PublishError(`RATE_LIMITED: LinkedIn rate limit exceeded`, {
			statusCode: res.status,
			detail: `HTTP ${res.status} ${res.statusText}`,
		});
	return res;
}

export function getLinkedInVideoPartSizes(
	instructions: Array<{ firstByte: number; lastByte: number }>,
	totalBytes: number,
): number[] {
	let nextFirstByte = 0;
	const partSizes = instructions.map((instruction) => {
		if (
			!Number.isSafeInteger(instruction.firstByte) ||
			!Number.isSafeInteger(instruction.lastByte) ||
			instruction.firstByte !== nextFirstByte ||
			instruction.lastByte < instruction.firstByte
		) {
			throw new Error(
				"LinkedIn returned non-contiguous video upload instructions",
			);
		}
		const partSize = instruction.lastByte - instruction.firstByte + 1;
		if (partSize > LINKEDIN_VIDEO_PART_MAX_BYTES) {
			throw new Error(
				"LinkedIn returned an oversized video upload instruction",
			);
		}
		nextFirstByte = instruction.lastByte + 1;
		return partSize;
	});
	if (nextFirstByte !== totalBytes) {
		throw new Error("LinkedIn video upload instructions do not cover the file");
	}
	return partSizes;
}

async function fetchMediaResponse(url: string): Promise<Response> {
	const res = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!res.ok) {
		throw new PublishError(
			`Failed to fetch media from ${url}: ${res.statusText}`,
			{
				statusCode: res.status,
				detail: `HTTP ${res.status} ${res.statusText}`,
			},
		);
	}
	return res;
}

/**
 * Upload an image to LinkedIn.
 * 1. Initialize upload → get uploadUrl + image URN
 * 2. PUT image bytes to uploadUrl
 * 3. Return image URN
 */
async function uploadImage(
	auth: LinkedInAuth,
	ownerUrn: string,
	mediaUrl: string,
): Promise<string> {
	// LinkedIn Images API — Initialize image upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api#initialize-image-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API_BASE}/rest/images?action=initializeUpload`,
		auth,
		{
			method: "POST",
			body: JSON.stringify({
				initializeUploadRequest: {
					owner: ownerUrn,
				},
			}),
		},
	);

	if (!initRes.ok) {
		const err = await readPublisherJson(initRes).catch(() => ({}));
		const raw = `HTTP ${initRes.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`LinkedIn image upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
			{ statusCode: initRes.status, detail: raw },
		);
	}

	const initData = (await readPublisherJson(initRes)) as {
		value: { uploadUrl: string; image: string };
	};
	const { uploadUrl, image: imageUrn } = initData.value;
	const mediaResponse = await ensureResponseContentLength(
		await fetchMediaResponse(mediaUrl),
		LINKEDIN_IMAGE_MAX_BYTES,
		() => fetchMediaResponse(mediaUrl),
	);
	const source = getFixedLengthResponseBody(
		mediaResponse,
		LINKEDIN_IMAGE_MAX_BYTES,
	);

	// LinkedIn Images API — Upload image binary to the pre-signed URL
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api#initialize-image-upload
	const uploadRes = await awaitResponseWithBodyCompletion(
		fetch(uploadUrl, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/octet-stream",
			},
			body: source.body,
		}),
		source.completion,
	);

	if (!uploadRes.ok) {
		throw new PublishError(
			`LinkedIn image upload failed: ${uploadRes.statusText}`,
			{
				statusCode: uploadRes.status,
				detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
			},
		);
	}

	await pollAssetStatus(auth, imageUrn, "images");
	return imageUrn;
}

/**
 * Upload a video to LinkedIn.
 * 1. Initialize upload → get uploadUrl + video URN
 * 2. PUT video bytes to uploadUrl
 * 3. Poll status until READY
 * 4. Return video URN
 */
async function uploadVideo(
	auth: LinkedInAuth,
	ownerUrn: string,
	mediaUrl: string,
): Promise<string> {
	let mediaResponse = await fetchMediaResponse(mediaUrl);
	mediaResponse = await ensureResponseContentLength(
		mediaResponse,
		LINKEDIN_VIDEO_MAX_BYTES,
		() => fetchMediaResponse(mediaUrl),
	);
	const size = parseContentLength(mediaResponse.headers) as number;

	// LinkedIn Videos API — Initialize video upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api#initialize-video-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API_BASE}/rest/videos?action=initializeUpload`,
		auth,
		{
			method: "POST",
			body: JSON.stringify({
				initializeUploadRequest: {
					owner: ownerUrn,
					fileSizeBytes: size,
					uploadCaptions: false,
					uploadThumbnail: false,
				},
			}),
		},
	);

	if (!initRes.ok) {
		void mediaResponse.body?.cancel().catch(() => {});
		const err = await readPublisherJson(initRes).catch(() => ({}));
		const raw = `HTTP ${initRes.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`LinkedIn video upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
			{ statusCode: initRes.status, detail: raw },
		);
	}

	const initData = (await readPublisherJson(initRes)) as {
		value: {
			video: string;
			uploadInstructions: Array<{
				uploadUrl: string;
				firstByte: number;
				lastByte: number;
			}>;
			uploadToken: string;
		};
	};
	const videoUrn = initData.value.video;
	const uploadInstructions = initData.value.uploadInstructions;
	const uploadToken = initData.value.uploadToken ?? "";
	if (!uploadInstructions || uploadInstructions.length === 0) {
		void mediaResponse.body?.cancel().catch(() => {});
		throw new Error("LinkedIn video upload: no upload instructions returned");
	}

	// LinkedIn Videos API — Upload video binary in parts to the pre-signed URLs
	// Large videos are split across multiple upload instructions (~4MB each)
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
	const uploadedPartIds: string[] = [];
	const partSizes = getLinkedInVideoPartSizes(uploadInstructions, size);
	const source = getChunkedResponseBody(
		mediaResponse,
		LINKEDIN_VIDEO_MAX_BYTES,
		partSizes,
	);
	let instructionIndex = 0;
	for await (const chunk of source.chunks) {
		const instruction = uploadInstructions[instructionIndex++];
		if (!instruction) {
			throw new Error(
				"LinkedIn returned fewer upload instructions than required",
			);
		}
		const expectedBytes = instruction.lastByte - instruction.firstByte + 1;
		if (chunk.byteLength !== expectedBytes) {
			throw new Error(
				`LinkedIn upload part ${instructionIndex} expected ${expectedBytes} bytes, got ${chunk.byteLength}`,
			);
		}
		const uploadRes = await fetch(instruction.uploadUrl, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/octet-stream",
			},
			body: chunk,
		});

		if (!uploadRes.ok) {
			throw new PublishError(
				`LinkedIn video part upload failed: ${uploadRes.statusText}`,
				{
					statusCode: uploadRes.status,
					detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
				},
			);
		}

		// Collect ETag for finalizeUpload — strip surrounding quotes per RFC 7232
		const rawEtag = uploadRes.headers.get("etag") ?? "";
		const etag = rawEtag.replace(/^"|"$/g, "");
		if (!etag) {
			throw new Error(
				`LinkedIn video part ${instructionIndex} upload did not return an ETag`,
			);
		}
		uploadedPartIds.push(etag);
	}
	if (instructionIndex !== uploadInstructions.length) {
		throw new Error(
			"LinkedIn returned more upload instructions than media parts",
		);
	}

	// LinkedIn Videos API — Finalize the upload (required step)
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
	const finalizeRes = await linkedinFetch(
		`${LINKEDIN_API_BASE}/rest/videos?action=finalizeUpload`,
		auth,
		{
			method: "POST",
			body: JSON.stringify({
				finalizeUploadRequest: {
					video: videoUrn,
					uploadToken,
					uploadedPartIds,
				},
			}),
		},
	);

	if (!finalizeRes.ok) {
		const err = await readPublisherJson(finalizeRes).catch(() => ({}));
		const raw = `HTTP ${finalizeRes.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`LinkedIn video finalize failed: ${(err as Record<string, string>).message ?? finalizeRes.statusText}`,
			{ statusCode: finalizeRes.status, detail: raw },
		);
	}

	// Poll for processing completion
	await pollAssetStatus(auth, videoUrn, "videos");

	return videoUrn;
}

/**
 * Poll video processing status until READY.
 */
async function pollAssetStatus(
	auth: LinkedInAuth,
	assetUrn: string,
	resource: "images" | "videos" | "documents",
): Promise<void> {
	const maxAttempts = 60;
	const pollInterval = 5000; // 5 seconds

	for (let i = 0; i < maxAttempts; i++) {
		if (i > 0) {
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
		}

		const encodedUrn = encodeURIComponent(assetUrn);
		// Official Images, Videos, and Documents API references expose the same
		// WAITING_UPLOAD / PROCESSING / PROCESSING_FAILED / AVAILABLE lifecycle.
		const res = await linkedinFetch(
			`${LINKEDIN_API_BASE}/rest/${resource}/${encodedUrn}`,
			auth,
			{ method: "GET" },
		);

		if (!res.ok) {
			throw new PublishError(
				`LinkedIn ${resource} status check failed: ${res.statusText}`,
				{
					statusCode: res.status,
					detail: `HTTP ${res.status} ${res.statusText}`,
				},
			);
		}

		const data = (await readPublisherJson(res)) as {
			status: string;
		};

		// Documented status values: PROCESSING, AVAILABLE,
		// PROCESSING_FAILED, WAITING_UPLOAD.
		if (data.status === "AVAILABLE") {
			return;
		}

		if (data.status === "PROCESSING_FAILED") {
			throw new Error(`LinkedIn ${resource} processing failed`);
		}
	}

	throw new PublishError(`LinkedIn ${resource} processing timed out`, {
		code: "PUBLISH_OUTCOME_UNKNOWN",
	});
}

/**
 * Upload a document to LinkedIn.
 * 1. Initialize upload → get uploadUrl + document URN
 * 2. PUT document bytes to uploadUrl
 * 3. Return document URN
 */
async function uploadDocument(
	auth: LinkedInAuth,
	ownerUrn: string,
	mediaUrl: string,
): Promise<string> {
	// LinkedIn Documents API — Initialize document upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api#initialize-document-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API_BASE}/rest/documents?action=initializeUpload`,
		auth,
		{
			method: "POST",
			body: JSON.stringify({
				initializeUploadRequest: {
					owner: ownerUrn,
				},
			}),
		},
	);

	if (!initRes.ok) {
		const err = await readPublisherJson(initRes).catch(() => ({}));
		const raw = `HTTP ${initRes.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`LinkedIn document upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
			{ statusCode: initRes.status, detail: raw },
		);
	}

	const initData = (await readPublisherJson(initRes)) as {
		value: { uploadUrl: string; document: string };
	};
	const { uploadUrl, document: documentUrn } = initData.value;
	const mediaResponse = await ensureResponseContentLength(
		await fetchMediaResponse(mediaUrl),
		LINKEDIN_DOCUMENT_MAX_BYTES,
		() => fetchMediaResponse(mediaUrl),
	);
	const source = getFixedLengthResponseBody(
		mediaResponse,
		LINKEDIN_DOCUMENT_MAX_BYTES,
	);

	// LinkedIn Documents API — Upload document binary to the pre-signed URL
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api#initialize-document-upload
	const uploadRes = await awaitResponseWithBodyCompletion(
		fetch(uploadUrl, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/octet-stream",
			},
			body: source.body,
		}),
		source.completion,
	);

	if (!uploadRes.ok) {
		throw new PublishError(
			`LinkedIn document upload failed: ${uploadRes.statusText}`,
			{
				statusCode: uploadRes.status,
				detail: `HTTP ${uploadRes.status} ${uploadRes.statusText}`,
			},
		);
	}

	await pollAssetStatus(auth, documentUrn, "documents");
	return documentUrn;
}

/**
 * Post a first comment on a LinkedIn post.
 */
async function postFirstComment(
	auth: LinkedInAuth,
	postUrn: string,
	authorUrn: string,
	commentText: string,
): Promise<string | undefined> {
	const encodedPostUrn = encodeURIComponent(postUrn);
	// LinkedIn Comments API — Post a comment on a post
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
	const res = await linkedinFetch(
		`${LINKEDIN_API_BASE}/rest/socialActions/${encodedPostUrn}/comments`,
		auth,
		{
			method: "POST",
			body: JSON.stringify({
				actor: authorUrn,
				object: postUrn,
				message: {
					// Comments API uses plain text, NOT Little Text Format
					text: commentText,
				},
			}),
		},
	);

	if (!res.ok) {
		const err = await readPublisherJson(res).catch(() => ({}));
		const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
		throw new PublishError(
			`LinkedIn first comment failed: ${(err as Record<string, string>).message ?? res.statusText}`,
			{ statusCode: res.status, detail: raw },
		);
	}
	const headerId = res.headers.get("x-restli-id") ?? undefined;
	const data = (await readPublisherJson(res).catch(() => ({}))) as {
		id?: string;
		commentUrn?: string;
	};
	return data.commentUrn ?? data.id ?? headerId;
}

/**
 * Determine the media type category for a set of media items.
 * LinkedIn cannot mix images with videos or documents.
 */
export function classifyMedia(
	media: Array<{ url: string; type?: string }>,
): "image" | "video" | "document" | "none" {
	if (media.length === 0) return "none";

	// Official docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
	// Section "Image Specifications" lists JPG, GIF, and PNG and allows GIFs up
	// to 250 frames. The Videos API "Video File Size Specifications" section at
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
	// documents MP4, so GIFs must use the Images API rather than the Videos API.
	const videoCount = media.filter((m) => m.type === "video").length;
	const documentCount = media.filter((m) => m.type === "document").length;
	const imageCount = media.filter(
		(m) => !m.type || m.type === "image" || m.type === "gif",
	).length;
	const hasVideo = videoCount > 0;
	const hasDocument = documentCount > 0;
	const hasImage = imageCount > 0;

	if (imageCount > 20) {
		// Official docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
		// Section "MultiImage schema" -> images has a minimum of 2 and maximum
		// of 20. One image uses the normal media content object.
		throw new Error(
			`CONTENT_ERROR: LinkedIn multi-image posts support at most 20 images; received ${imageCount}.`,
		);
	}
	if (videoCount > 1) {
		// Official docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
		// Section "Create a post" -> content.media contains one media URN.
		throw new Error("CONTENT_ERROR: LinkedIn supports one video per post.");
	}
	if (documentCount > 1) {
		// Same official Posts API section: a document post uses one content.media
		// object and therefore one uploaded document URN.
		throw new Error("CONTENT_ERROR: LinkedIn supports one document per post.");
	}

	if (hasVideo && (hasImage || hasDocument)) {
		throw new Error(
			"CONTENT_ERROR: LinkedIn does not allow mixing videos with images or documents.",
		);
	}
	if (hasDocument && hasImage) {
		throw new Error(
			"CONTENT_ERROR: LinkedIn does not allow mixing documents with images.",
		);
	}

	if (hasVideo) return "video";
	if (hasDocument) return "document";
	return "image";
}

/**
 * Escape reserved characters in LinkedIn "little text format" for use in post commentary.
 * Preserves mention annotations like @[Name](urn:li:organization:123) by only escaping
 * text outside of those patterns.
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 */
export function escapeLinkedInCommentary(text: string): string {
	// Pattern matching LinkedIn mention syntax: @[display name](urn:li:...)
	const mentionPattern = /@\[.+?\]\(urn:li:\w+:.+?\)/g;
	const mentions = text.match(mentionPattern) || [];
	const segments = text.split(mentionPattern);

	const escapedSegments = segments.map((segment) =>
		segment.replace(/([|{}@[\]()<>#\\*_~])/g, "\\$1"),
	);

	// Interleave escaped segments with preserved mentions
	const result: string[] = [];
	for (const [i, segment] of escapedSegments.entries()) {
		result.push(segment);
		const mention = mentions[i];
		if (mention !== undefined) {
			result.push(mention);
		}
	}
	return result.join("");
}

function linkedinPostUrl(postUrn: string): string {
	return `https://www.linkedin.com/feed/update/${postUrn}`;
}

function linkedinPostEffect(
	effects: readonly ProviderEffect[],
): ProviderEffect | undefined {
	return effects.find(
		(effect) =>
			effect.name === "post_published" &&
			effect.status === "succeeded" &&
			!!effect.provider_id?.trim(),
	);
}

export const linkedinPublisher: Publisher = {
	platform: "linkedin",

	async reconcile(request: ReconcileRequest): Promise<PublishResult> {
		const persistedPostUrn = request.platform_post_id?.trim();
		const confirmedPostUrn = linkedinPostEffect(
			request.effects,
		)?.provider_id?.trim();
		if (
			persistedPostUrn &&
			confirmedPostUrn &&
			persistedPostUrn !== confirmedPostUrn
		) {
			return {
				success: false,
				provider_outcome: {
					disposition: "outcome_unknown",
					platform_post_id: persistedPostUrn,
					effects: request.effects,
				},
				error: {
					code: "PROVIDER_IDENTITY_MISMATCH",
					message:
						"The persisted LinkedIn post URN does not match its durable provider effect.",
				},
			};
		}
		const postUrn = persistedPostUrn || confirmedPostUrn;
		if (!postUrn) {
			return {
				success: false,
				provider_outcome: {
					disposition: "outcome_unknown",
					effects: request.effects,
				},
				error: {
					code: "MISSING_PROVIDER_POST_ID",
					message:
						"LinkedIn reconciliation requires the post URN returned by the create request.",
				},
			};
		}

		const platformUrl = linkedinPostUrl(postUrn);
		// The effect is written only after LinkedIn returned 201 plus x-restli-id.
		// That durable confirmation is sufficient to finish local recovery and does
		// not require read scopes (`r_member_social` / `r_organization_social`) that
		// are distinct from Relay's publishing scopes. Legacy rows without the
		// confirmation effect fall through to the read-only provider lookup below.
		if (confirmedPostUrn) {
			return {
				success: true,
				platform_post_id: postUrn,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "published",
					provider_operation_id: postUrn,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_state: request.provider_state ?? "PUBLISHED",
					effects: request.effects,
				},
			};
		}
		try {
			// LinkedIn Posts API, "Get Posts by URN": GET the URL-encoded share or
			// UGC-post URN. AUTHOR view exposes PUBLISH_REQUESTED/PUBLISH_FAILED as
			// well as the terminal PUBLISHED lifecycle without creating new content.
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api#get-posts-by-urn
			const response = await linkedinFetch(
				`${LINKEDIN_API_BASE}/rest/posts/${encodeURIComponent(postUrn)}?viewContext=AUTHOR`,
				{ access_token: request.account.access_token },
				{ method: "GET" },
			);
			if (response.status === 404) {
				await response.body?.cancel().catch(() => {});
				return {
					success: false,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_outcome: {
						disposition: "failed",
						provider_operation_id: postUrn,
						platform_post_id: postUrn,
						platform_url: platformUrl,
						provider_state: "NOT_FOUND",
						effects: request.effects,
					},
					error: {
						code: "LINKEDIN_POST_NOT_FOUND",
						message:
							"LinkedIn no longer returns the post created by this publish operation.",
					},
				};
			}
			if (!response.ok) {
				throw new PublishError(
					`LinkedIn post status failed: ${response.statusText}`,
					{
						statusCode: response.status,
						detail: `HTTP ${response.status} ${response.statusText}`,
					},
				);
			}

			const data = (await readPublisherJson(response)) as {
				id?: string;
				author?: string;
				lifecycleState?: string;
			};
			if (
				(data.id && data.id !== postUrn) ||
				(data.author && data.author !== request.account.platform_account_id)
			) {
				throw new PublishError(
					"LinkedIn returned a post outside the connected publish identity",
					{ code: "PROVIDER_PROTOCOL_ERROR" },
				);
			}

			const providerState = data.lifecycleState?.toUpperCase();
			const shared = {
				provider_operation_id: postUrn,
				platform_post_id: postUrn,
				platform_url: platformUrl,
				provider_state: providerState,
				effects: request.effects,
			};
			if (providerState === "PUBLISHED") {
				return {
					success: true,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_outcome: { disposition: "published", ...shared },
				};
			}
			if (
				providerState === "PUBLISH_REQUESTED" ||
				providerState === "PROCESSING" ||
				providerState === "DRAFT"
			) {
				return {
					success: true,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_outcome: { disposition: "processing", ...shared },
				};
			}
			if (providerState === "PUBLISH_FAILED") {
				return {
					success: false,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_outcome: { disposition: "failed", ...shared },
					error: {
						code: "LINKEDIN_PUBLISH_FAILED",
						message: "LinkedIn failed to publish the accepted post.",
					},
				};
			}

			return {
				success: false,
				platform_post_id: postUrn,
				platform_url: platformUrl,
				provider_outcome: { disposition: "outcome_unknown", ...shared },
				error: {
					code: "PUBLISH_OUTCOME_UNKNOWN",
					message: `LinkedIn returned an unrecognized post lifecycle: ${providerState ?? "missing"}.`,
				},
			};
		} catch (error) {
			const result = classifyPublishError(error);
			return {
				...result,
				platform_post_id: postUrn,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "outcome_unknown",
					provider_operation_id: postUrn,
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_state: request.provider_state ?? undefined,
					effects: request.effects,
				},
			};
		}
	},

	async repost(
		account: EngagementAccount,
		platformPostId: string,
	): Promise<EngagementActionResult> {
		try {
			const auth: LinkedInAuth = { access_token: account.access_token };
			const authorUrn = account.platform_account_id;
			// LinkedIn Posts API — Reshare a post
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api#create-a-post
			const res = await linkedinFetch(`${LINKEDIN_API_BASE}/rest/posts`, auth, {
				method: "POST",
				body: JSON.stringify({
					author: authorUrn,
					commentary: "",
					visibility: "PUBLIC",
					distribution: {
						feedDistribution: "MAIN_FEED",
						targetEntities: [],
						thirdPartyDistributionChannels: [],
					},
					lifecycleState: "PUBLISHED",
					isReshareDisabledByAuthor: false,
					reshareContext: {
						parent: platformPostId,
					},
				}),
			});
			if (!res.ok) {
				const err = await readPublisherJson(res).catch(() => ({}));
				const detail =
					(err as Record<string, string>).message ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(`LinkedIn reshare failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}
			const postUrn = res.headers.get("x-restli-id") ?? "";
			return { success: true, platform_post_id: postUrn };
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
			const auth: LinkedInAuth = { access_token: account.access_token };
			const authorUrn = account.platform_account_id;
			const encodedPostUrn = encodeURIComponent(platformPostId);
			// LinkedIn Comments API — Post a comment on a post
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
			const res = await linkedinFetch(
				`${LINKEDIN_API_BASE}/rest/socialActions/${encodedPostUrn}/comments`,
				auth,
				{
					method: "POST",
					body: JSON.stringify({
						actor: authorUrn,
						object: platformPostId,
						message: { text },
					}),
				},
			);
			if (!res.ok) {
				const err = await readPublisherJson(res).catch(() => ({}));
				const detail =
					(err as Record<string, string>).message ?? res.statusText;
				const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
				throw new PublishError(`LinkedIn comment failed: ${detail}`, {
					statusCode: res.status,
					detail: raw,
				});
			}
			const data = (await readPublisherJson(res)) as {
				id?: string;
				commentUrn?: string;
			};
			return { success: true, platform_post_id: data.commentUrn ?? data.id };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const auth: LinkedInAuth = {
				access_token: request.account.access_token,
			};
			const opts = request.target_options;

			// Author identity is selected and role-checked by the connection flow. A
			// publish payload must not redirect a member/org token to a different URN.
			const authorUrn = request.account.platform_account_id;
			if (
				typeof opts.organization_urn === "string" &&
				opts.organization_urn.trim() &&
				opts.organization_urn.trim() !== authorUrn
			) {
				return {
					success: false,
					error: {
						code: "ORGANIZATION_URN_MISMATCH",
						message:
							"target_options.organization_urn does not match the connected LinkedIn identity.",
					},
				};
			}

			// Resolve content — target_options.content overrides request.content
			const content = (opts.content as string) ?? request.content ?? "";

			// Validate character limit
			if (content.length > CHARACTER_LIMIT) {
				return {
					success: false,
					error: {
						code: "CONTENT_TOO_LONG",
						message: `Content is ${content.length} characters. LinkedIn limit is ${CHARACTER_LIMIT}.`,
					},
				};
			}

			// Resolve media — target_options.media overrides request.media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// Classify and validate media types
			const mediaCategory = classifyMedia(media);
			const confirmedEffects: ProviderEffect[] = [];
			const persistConfirmedEffect = async (
				effect: ProviderEffect,
			): Promise<void> => {
				confirmedEffects.push(effect);
				await recordProviderEffect(request, effect);
			};
			let postUrn = getSucceededProviderEffect(
				request,
				"post_published",
			)?.provider_id;

			// Build the post body
			const postBody: Record<string, unknown> = {
				author: authorUrn,
				commentary: escapeLinkedInCommentary(content),
				visibility: "PUBLIC",
				distribution: {
					feedDistribution: "MAIN_FEED",
					targetEntities: [],
					thirdPartyDistributionChannels: [],
				},
				lifecycleState: "PUBLISHED",
				isReshareDisabledByAuthor: false,
			};

			// LinkedIn has no direct link-preview suppression field. If requested,
			// publish truthfully and record an explicit unsupported target effect below
			// instead of silently pretending the option was honored.

			// Handle media content
			if (!postUrn && mediaCategory === "image") {
				const imageMedia = media.filter(
					(m) => !m.type || m.type === "image" || m.type === "gif",
				);
				const imageUrns = await Promise.all(
					imageMedia.map(async (item, index) => {
						const effectName = `media_asset_${index + 1}`;
						const recorded = getSucceededProviderEffect(request, effectName);
						if (recorded?.provider_id) return recorded.provider_id;
						const imageUrn = await uploadImage(auth, authorUrn, item.url);
						await persistConfirmedEffect({
							name: effectName,
							status: "succeeded",
							provider_id: imageUrn,
						});
						return imageUrn;
					}),
				);

				if (imageUrns.length === 1) {
					postBody.content = {
						media: { id: imageUrns[0] },
					};
				} else {
					postBody.content = {
						multiImage: {
							images: imageUrns.map((urn, idx) => ({
								id: urn,
								altText:
									(imageMedia[idx] as { alt_text?: string } | undefined)
										?.alt_text ?? "",
							})),
						},
					};
				}
			} else if (!postUrn && mediaCategory === "video") {
				const videoItem = media.find((m) => m.type === "video");
				if (videoItem) {
					let videoUrn = getSucceededProviderEffect(
						request,
						"media_asset_1",
					)?.provider_id;
					if (!videoUrn) {
						videoUrn = await uploadVideo(auth, authorUrn, videoItem.url);
						await persistConfirmedEffect({
							name: "media_asset_1",
							status: "succeeded",
							provider_id: videoUrn,
						});
					}
					postBody.content = {
						media: {
							id: videoUrn,
						},
					};
				}
			} else if (!postUrn && mediaCategory === "document") {
				const docItem = media.find((m) => m.type === "document");
				if (docItem) {
					let documentUrn = getSucceededProviderEffect(
						request,
						"media_asset_1",
					)?.provider_id;
					if (!documentUrn) {
						documentUrn = await uploadDocument(auth, authorUrn, docItem.url);
						await persistConfirmedEffect({
							name: "media_asset_1",
							status: "succeeded",
							provider_id: documentUrn,
						});
					}
					const documentTitle = (opts.document_title as string) ?? "Document";
					postBody.content = {
						media: {
							id: documentUrn,
							title: documentTitle,
						},
					};
				}
			}

			// LinkedIn Posts API — Create a post
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api#create-a-post
			if (!postUrn) {
				const res = await linkedinFetch(
					`${LINKEDIN_API_BASE}/rest/posts`,
					auth,
					{
						method: "POST",
						body: JSON.stringify(postBody),
					},
				);

				if (!res.ok) {
					const err = await readPublisherJson(res).catch(() => ({}));
					const detail =
						(err as Record<string, string>).message ?? res.statusText;
					const raw = `HTTP ${res.status}\n${JSON.stringify(err)}`;
					if (
						res.status === 401 ||
						detail.includes("Unauthorized") ||
						detail.includes("invalid_grant")
					) {
						throw new PublishError(`TOKEN_EXPIRED: ${detail}`, {
							statusCode: res.status,
							detail: raw,
						});
					}
					if (res.status === 429) {
						throw new PublishError(`RATE_LIMITED: ${detail}`, {
							statusCode: res.status,
							detail: raw,
						});
					}
					throw new PublishError(`LinkedIn post creation failed: ${detail}`, {
						statusCode: res.status,
						detail: raw,
					});
				}

				// LinkedIn returns the post URN in the x-restli-id header.
				postUrn =
					res.headers.get("x-restli-id") ??
					res.headers.get("x-linkedin-id") ??
					undefined;

				if (!postUrn?.trim()) {
					return {
						success: false,
						provider_outcome: {
							disposition: "outcome_unknown",
							provider_state: "created_without_post_id",
							effects: mergeProviderEffects(
								request.effect_recorder?.effects,
								confirmedEffects,
							),
						},
						error: {
							code: "PUBLISH_OUTCOME_UNKNOWN",
							message:
								"LinkedIn created the post but did not return the required x-restli-id header.",
						},
					};
				}
				await persistConfirmedEffect({
					name: "post_published",
					status: "succeeded",
					provider_id: postUrn,
				});
			}

			const effects: ProviderEffect[] = [];
			if (opts.disable_link_preview === true) {
				effects.push({
					name: "disable_link_preview",
					status: "unsupported",
					error: {
						code: "UNSUPPORTED_OPTION",
						message:
							"LinkedIn does not support suppressing an automatically generated link preview; the post was published without applying this option.",
					},
				});
			}
			// Post first comment if requested
			const firstComment = opts.first_comment as string | undefined;
			const recordedComment = request.effect_recorder?.effects.find(
				(effect) => effect.name === "first_comment",
			);
			if (
				firstComment &&
				recordedComment?.status !== "succeeded" &&
				recordedComment?.status !== "outcome_unknown"
			) {
				let commentEffect: ProviderEffect;
				try {
					const commentId = await postFirstComment(
						auth,
						postUrn,
						authorUrn,
						firstComment,
					);
					commentEffect = {
						name: "first_comment",
						status: commentId ? "succeeded" : "outcome_unknown",
						provider_id: commentId,
					};
				} catch (commentErr) {
					commentEffect = {
						name: "first_comment",
						status:
							commentErr instanceof PublishError && commentErr.statusCode
								? "failed"
								: "outcome_unknown",
						error: {
							code: "PLATFORM_ERROR",
							message:
								commentErr instanceof Error
									? commentErr.message
									: "LinkedIn first comment failed",
						},
					};
				}
				await persistConfirmedEffect(commentEffect);
			}

			// Build the post URL — use raw URN (LinkedIn URLs use unencoded URNs)
			const platformUrl = linkedinPostUrl(postUrn);
			const providerEffects = mergeProviderEffects(
				request.effect_recorder?.effects,
				confirmedEffects,
				effects,
			);

			return {
				success: true,
				platform_post_id: postUrn,
				platform_url: platformUrl,
				provider_outcome: {
					disposition: "published",
					platform_post_id: postUrn,
					platform_url: platformUrl,
					provider_state: "PUBLISHED",
					effects: providerEffects,
				},
			};
		} catch (err) {
			return classifyPublishError(err, { safeToRetryRateLimit: true });
		}
	},
};
