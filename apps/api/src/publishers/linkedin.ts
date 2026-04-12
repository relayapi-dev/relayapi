import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type EngagementAccount, type EngagementActionResult, type Publisher, type PublishRequest, type PublishResult } from "./types";

const LINKEDIN_API = "https://api.linkedin.com";
const LINKEDIN_VERSION = "202603";
const CHARACTER_LIMIT = 3000;

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
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/json",
			"Linkedin-Version": LINKEDIN_VERSION,
			"X-Restli-Protocol-Version": "2.0.0",
			...(options.headers ?? {}),
		},
	});
	// Classify HTTP-level errors that apply to all LinkedIn API calls
	if (res.status === 401) throw new Error(`TOKEN_EXPIRED: LinkedIn token expired or invalid`);
	if (res.status === 429) throw new Error(`RATE_LIMITED: LinkedIn rate limit exceeded`);
	return res;
}

/**
 * Fetch media bytes from a URL.
 */
async function fetchMediaBytes(
	url: string,
): Promise<{ bytes: ArrayBuffer; contentType: string; size: number }> {
	const res = await fetchPublicUrl(url, { timeout: 30_000 });
	if (!res.ok) {
		throw new Error(`Failed to fetch media from ${url}: ${res.statusText}`);
	}
	const bytes = await res.arrayBuffer();
	const contentType =
		res.headers.get("content-type") ?? "application/octet-stream";
	return { bytes, contentType, size: bytes.byteLength };
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
	const { bytes } = await fetchMediaBytes(mediaUrl);

	// LinkedIn Images API — Initialize image upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api#initialize-image-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API}/rest/images?action=initializeUpload`,
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
		const err = await initRes.json().catch(() => ({}));
		throw new Error(
			`LinkedIn image upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
		);
	}

	const initData = (await initRes.json()) as {
		value: { uploadUrl: string; image: string };
	};
	const { uploadUrl, image: imageUrn } = initData.value;

	// LinkedIn Images API — Upload image binary to the pre-signed URL
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api#initialize-image-upload
	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/octet-stream",
		},
		body: bytes,
	});

	if (!uploadRes.ok) {
		throw new Error(`LinkedIn image upload failed: ${uploadRes.statusText}`);
	}

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
	const { bytes, size } = await fetchMediaBytes(mediaUrl);

	// LinkedIn Videos API — Initialize video upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api#initialize-video-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API}/rest/videos?action=initializeUpload`,
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
		const err = await initRes.json().catch(() => ({}));
		throw new Error(
			`LinkedIn video upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
		);
	}

	const initData = (await initRes.json()) as {
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
		throw new Error("LinkedIn video upload: no upload instructions returned");
	}

	// LinkedIn Videos API — Upload video binary in parts to the pre-signed URLs
	// Large videos are split across multiple upload instructions (~4MB each)
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
	const uploadedPartIds: string[] = [];
	for (const instruction of uploadInstructions) {
		const chunk = bytes.slice(instruction.firstByte, instruction.lastByte + 1);
		const uploadRes = await fetch(instruction.uploadUrl, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${auth.access_token}`,
				"Content-Type": "application/octet-stream",
			},
			body: chunk,
		});

		if (!uploadRes.ok) {
			throw new Error(
				`LinkedIn video part upload failed: ${uploadRes.statusText}`,
			);
		}

		// Collect ETag for finalizeUpload — strip surrounding quotes per RFC 7232
		const rawEtag = uploadRes.headers.get("etag") ?? "";
		const etag = rawEtag.replace(/^"|"$/g, "");
		uploadedPartIds.push(etag);
	}

	// LinkedIn Videos API — Finalize the upload (required step)
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
	const finalizeRes = await linkedinFetch(
		`${LINKEDIN_API}/rest/videos?action=finalizeUpload`,
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
		const err = await finalizeRes.json().catch(() => ({}));
		throw new Error(
			`LinkedIn video finalize failed: ${(err as Record<string, string>).message ?? finalizeRes.statusText}`,
		);
	}

	// Poll for processing completion
	await pollVideoStatus(auth, videoUrn);

	return videoUrn;
}

/**
 * Poll video processing status until READY.
 */
async function pollVideoStatus(
	auth: LinkedInAuth,
	videoUrn: string,
): Promise<void> {
	const maxAttempts = 60;
	const pollInterval = 5000; // 5 seconds

	for (let i = 0; i < maxAttempts; i++) {
		await new Promise((resolve) => setTimeout(resolve, pollInterval));

		const encodedUrn = encodeURIComponent(videoUrn);
		// LinkedIn Videos API — Get video status
		// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
		const res = await linkedinFetch(
			`${LINKEDIN_API}/rest/videos/${encodedUrn}`,
			auth,
			{ method: "GET" },
		);

		if (!res.ok) {
			throw new Error(`LinkedIn video status check failed: ${res.statusText}`);
		}

		const data = (await res.json()) as {
			status: string;
		};

		// LinkedIn video status values: PROCESSING, AVAILABLE, PROCESSING_FAILED, WAITING_UPLOAD
		if (data.status === "AVAILABLE") {
			return;
		}

		if (data.status === "PROCESSING_FAILED") {
			throw new Error("LinkedIn video processing failed");
		}
	}

	throw new Error("LinkedIn video processing timed out");
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
	const { bytes } = await fetchMediaBytes(mediaUrl);

	// LinkedIn Documents API — Initialize document upload
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api#initialize-document-upload
	const initRes = await linkedinFetch(
		`${LINKEDIN_API}/rest/documents?action=initializeUpload`,
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
		const err = await initRes.json().catch(() => ({}));
		throw new Error(
			`LinkedIn document upload init failed: ${(err as Record<string, string>).message ?? initRes.statusText}`,
		);
	}

	const initData = (await initRes.json()) as {
		value: { uploadUrl: string; document: string };
	};
	const { uploadUrl, document: documentUrn } = initData.value;

	// LinkedIn Documents API — Upload document binary to the pre-signed URL
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api#initialize-document-upload
	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${auth.access_token}`,
			"Content-Type": "application/octet-stream",
		},
		body: bytes,
	});

	if (!uploadRes.ok) {
		throw new Error(`LinkedIn document upload failed: ${uploadRes.statusText}`);
	}

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
): Promise<void> {
	const encodedPostUrn = encodeURIComponent(postUrn);
	// LinkedIn Comments API — Post a comment on a post
	// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
	const res = await linkedinFetch(
		`${LINKEDIN_API}/rest/socialActions/${encodedPostUrn}/comments`,
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
		const err = await res.json().catch(() => ({}));
		throw new Error(
			`LinkedIn first comment failed: ${(err as Record<string, string>).message ?? res.statusText}`,
		);
	}
}

/**
 * Determine the media type category for a set of media items.
 * LinkedIn cannot mix images with videos or documents.
 */
function classifyMedia(
	media: Array<{ url: string; type?: string }>,
): "image" | "video" | "document" | "none" {
	if (media.length === 0) return "none";

	const hasVideo = media.some((m) => m.type === "video" || m.type === "gif");
	const hasDocument = media.some((m) => m.type === "document");
	const hasImage = media.some((m) => !m.type || m.type === "image");

	if (hasVideo && (hasImage || hasDocument)) {
		throw new Error(
			"LinkedIn does not allow mixing media types. Cannot combine videos with images or documents.",
		);
	}
	if (hasDocument && hasImage) {
		throw new Error(
			"LinkedIn does not allow mixing media types. Cannot combine documents with images.",
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
		segment.replace(/([|{}@\[\]()<>#\\*_~])/g, "\\$1"),
	);

	// Interleave escaped segments with preserved mentions
	const result: string[] = [];
	for (let i = 0; i < escapedSegments.length; i++) {
		result.push(escapedSegments[i]!);
		if (i < mentions.length) {
			result.push(mentions[i]!);
		}
	}
	return result.join("");
}

export const linkedinPublisher: Publisher = {
	platform: "linkedin",

	async repost(account: EngagementAccount, platformPostId: string): Promise<EngagementActionResult> {
		try {
			const auth: LinkedInAuth = { access_token: account.access_token };
			const authorUrn = account.platform_account_id;
			// LinkedIn Posts API — Reshare a post
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api#create-a-post
			const res = await linkedinFetch(`${LINKEDIN_API}/rest/posts`, auth, {
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
				const err = await res.json().catch(() => ({}));
				const detail = (err as Record<string, string>).message ?? res.statusText;
				throw new Error(`LinkedIn reshare failed: ${detail}`);
			}
			const postUrn = res.headers.get("x-restli-id") ?? "";
			return { success: true, platform_post_id: postUrn };
		} catch (err) {
			const result = classifyPublishError(err);
			return { success: false, error: result.error };
		}
	},

	async comment(account: EngagementAccount, platformPostId: string, text: string): Promise<EngagementActionResult> {
		try {
			const auth: LinkedInAuth = { access_token: account.access_token };
			const authorUrn = account.platform_account_id;
			const encodedPostUrn = encodeURIComponent(platformPostId);
			// LinkedIn Comments API — Post a comment on a post
			// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
			const res = await linkedinFetch(
				`${LINKEDIN_API}/rest/socialActions/${encodedPostUrn}/comments`,
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
				const err = await res.json().catch(() => ({}));
				const detail = (err as Record<string, string>).message ?? res.statusText;
				throw new Error(`LinkedIn comment failed: ${detail}`);
			}
			const data = (await res.json()) as { id?: string; commentUrn?: string };
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

			// Determine author URN — use organization_urn from target_options if provided,
			// otherwise fall back to the platform_account_id (person or org URN)
			const authorUrn =
				(opts.organization_urn as string) ??
				request.account.platform_account_id;

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

			// Note: LinkedIn does not have a direct "disable link preview" field.
			// The only way to suppress auto-generated link previews is to not include
			// a URL in the commentary text. The disable_link_preview option is a no-op.

			// Handle media content
			if (mediaCategory === "image") {
				const imageUrns = await Promise.all(
					media
						.filter((m) => !m.type || m.type === "image")
						.map((m) => uploadImage(auth, authorUrn, m.url)),
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
								altText: (media.filter((m) => !m.type || m.type === "image")[idx] as any)?.alt_text ?? "",
							})),
						},
					};
				}
			} else if (mediaCategory === "video") {
				// GIFs count as video on LinkedIn
				const videoItem = media.find(
					(m) => m.type === "video" || m.type === "gif",
				);
				if (videoItem) {
					const videoUrn = await uploadVideo(auth, authorUrn, videoItem.url);
					postBody.content = {
						media: {
							id: videoUrn,
						},
					};
				}
			} else if (mediaCategory === "document") {
				const docItem = media.find((m) => m.type === "document");
				if (docItem) {
					const documentUrn = await uploadDocument(
						auth,
						authorUrn,
						docItem.url,
					);
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
			const res = await linkedinFetch(`${LINKEDIN_API}/rest/posts`, auth, {
				method: "POST",
				body: JSON.stringify(postBody),
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				const detail =
					(err as Record<string, string>).message ?? res.statusText;
				if (res.status === 401 || detail.includes("Unauthorized") || detail.includes("invalid_grant")) {
					throw new Error(`TOKEN_EXPIRED: ${detail}`);
				}
				if (res.status === 429) {
					throw new Error(`RATE_LIMITED: ${detail}`);
				}
				throw new Error(`LinkedIn post creation failed: ${detail}`);
			}

			// LinkedIn returns the post URN in the x-restli-id header
			const postUrn =
				res.headers.get("x-restli-id") ??
				res.headers.get("x-linkedin-id") ??
				"";

			// Post first comment if requested
			const firstComment = opts.first_comment as string | undefined;
			if (firstComment && postUrn) {
				try {
					await postFirstComment(auth, postUrn, authorUrn, firstComment);
				} catch (commentErr) {
					console.error(
						`LinkedIn first comment failed for post ${postUrn}:`,
						commentErr,
					);
				}
			}

			// Build the post URL — use raw URN (LinkedIn URLs use unencoded URNs)
			const platformUrl = `https://www.linkedin.com/feed/update/${postUrn}`;

			return {
				success: true,
				platform_post_id: postUrn,
				platform_url: platformUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
