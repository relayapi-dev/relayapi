import { fetchPublicUrl } from "../lib/fetch-public-url";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

const REDDIT_API = "https://oauth.reddit.com";

async function redditFetch(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<Response> {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "web:RelayAPI:v1.0 (by /u/relayapi)",
			...(options.headers ?? {}),
		},
	});
	if (res.status === 401) throw new Error("TOKEN_EXPIRED: Reddit access token invalid or expired");
	if (res.status === 429) throw new Error("RATE_LIMITED: Reddit rate limit exceeded");
	// Read Reddit rate limit headers for proactive throttling
	// Docs: https://github.com/reddit-archive/reddit/wiki/API (Rules section)
	const remaining = res.headers.get("x-ratelimit-remaining");
	if (remaining !== null && Number.parseFloat(remaining) <= 1) {
		const resetSecs = res.headers.get("x-ratelimit-reset");
		throw new Error(`RATE_LIMITED: Reddit rate limit nearly exhausted. Resets in ${resetSecs ?? "unknown"} seconds.`);
	}
	return res;
}

interface RedditMediaAssetResponse {
	args: {
		action: string;
		fields: Array<{ name: string; value: string }>;
	};
	asset: {
		asset_id: string;
		websocket_url: string;
	};
}

interface RedditGallerySubmitResponse {
	json: {
		errors: Array<[string, string, string]>;
		data?: {
			url?: string;
			id?: string;
		};
	};
}

/**
 * Upload a media asset to Reddit's hosting via the /api/media/asset.json flow.
 * 1. Request an upload lease from Reddit
 * 2. Upload the file binary to the S3 URL
 * 3. Return the Reddit-hosted URL and asset_id
 */
async function uploadMediaAsset(
	accessToken: string,
	fileUrl: string,
	filename: string,
	mimetype: string,
): Promise<{ url: string; assetId: string }> {
	// Step 1: Request an upload lease
	const leaseBody = new URLSearchParams({
		filepath: filename,
		mimetype,
	});

	const leaseRes = await redditFetch(
		`${REDDIT_API}/api/media/asset.json`,
		accessToken,
		{
			method: "POST",
			body: leaseBody.toString(),
		},
	);

	if (!leaseRes.ok) {
		const errText = await leaseRes.text().catch(() => leaseRes.statusText);
		throw new Error(`Reddit media asset lease failed: ${errText}`);
	}

	const leaseData = (await leaseRes.json()) as RedditMediaAssetResponse;
	const { args, asset } = leaseData;

	// Step 2: Fetch the file binary from the provided URL
	const fileRes = await fetchPublicUrl(fileUrl, { timeout: 30_000 });
	if (!fileRes.ok) {
		throw new Error(`Failed to fetch media file from ${fileUrl}`);
	}
	const fileBlob = await fileRes.blob();

	// Step 3: Upload to S3 using multipart/form-data
	const uploadUrl = args.action.startsWith("http")
		? args.action
		: `https:${args.action}`;

	const formData = new FormData();
	for (const field of args.fields) {
		formData.append(field.name, field.value);
	}
	formData.append("file", fileBlob, filename);

	const uploadRes = await fetch(uploadUrl, {
		method: "POST",
		body: formData,
	});

	// S3 returns 201 Created with a Location header containing the hosted URL
	if (uploadRes.status === 201 || uploadRes.ok) {
		const location = uploadRes.headers.get("Location");
		if (location) {
			return {
				url: decodeURIComponent(location),
				assetId: asset.asset_id,
			};
		}
	}

	// Fallback: construct URL from asset_id
	return {
		url: `https://reddit.com/media?id=${asset.asset_id}`,
		assetId: asset.asset_id,
	};
}

/**
 * Infer a filename and mimetype from a media URL.
 */
function inferMediaInfo(url: string): { filename: string; mimetype: string } {
	const pathname = new URL(url).pathname;
	const ext = pathname.split(".").pop()?.toLowerCase() ?? "jpg";
	const mimeMap: Record<string, string> = {
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		png: "image/png",
		gif: "image/gif",
		webp: "image/webp",
		mp4: "video/mp4",
		mov: "video/quicktime",
		webm: "video/webm",
	};
	const isVideo = ext === "mp4" || ext === "mov" || ext === "webm";
	return {
		filename: isVideo ? `video.${ext}` : `image.${ext}`,
		mimetype: mimeMap[ext] ?? "image/jpeg",
	};
}

/**
 * Submit a gallery post with multiple images.
 * Uses /api/submit_gallery_post.json which accepts pre-uploaded media assets.
 */
async function submitGalleryPost(
	accessToken: string,
	sr: string,
	title: string,
	items: Array<{ mediaId: string; caption: string }>,
	extraParams?: { flair_id?: string; nsfw?: string; spoiler?: string },
): Promise<RedditGallerySubmitResponse> {
	const payload: Record<string, unknown> = {
		sr,
		title,
		api_type: "json",
		items: items.map((item) => ({
			media_id: item.mediaId,
			caption: item.caption,
		})),
	};

	if (extraParams?.flair_id) payload.flair_id = extraParams.flair_id;
	if (extraParams?.nsfw === "true") payload.nsfw = true;
	if (extraParams?.spoiler === "true") payload.spoiler = true;

	const res = await fetch(`${REDDIT_API}/api/submit_gallery_post.json`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "web:RelayAPI:v1.0 (by /u/relayapi)",
		},
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => res.statusText);
		throw new Error(`Reddit gallery submit failed: ${errText}`);
	}

	return res.json() as Promise<RedditGallerySubmitResponse>;
}

interface RedditSubmitResponse {
	json: {
		errors: Array<[string, string, string]>;
		data?: {
			url?: string;
			id?: string;
			name?: string;
			websocket_url?: string;
		};
	};
}

/**
 * Wait for Reddit's WebSocket to return the real post URL after a media submission.
 * Reddit returns a websocket_url for image/video posts instead of the final URL.
 * Returns null if the WebSocket times out or fails.
 */
async function waitForRedditWebSocket(
	wsUrl: string,
	timeoutMs = 30000,
): Promise<{ id: string; name: string; url: string } | null> {
	return new Promise((resolve) => {
		const ws = new WebSocket(wsUrl);
		const timer = setTimeout(() => {
			ws.close();
			resolve(null);
		}, timeoutMs);

		ws.addEventListener("message", (event) => {
			try {
				const data = JSON.parse(typeof event.data === "string" ? event.data : "");
				if (data?.payload?.redirect) {
					clearTimeout(timer);
					ws.close();
					const match = data.payload.redirect.match(/\/comments\/([a-z0-9]+)\//);
					const id = match?.[1] ?? "";
					resolve({
						id,
						name: `t3_${id}`,
						url: data.payload.redirect,
					});
				} else if (data?.type === "failed") {
					clearTimeout(timer);
					ws.close();
					resolve(null);
				}
			} catch {
				// Ignore parse errors
			}
		});

		ws.addEventListener("error", () => {
			clearTimeout(timer);
			resolve(null);
		});

		ws.addEventListener("close", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}

function extractTitleAndBody(content: string): {
	title: string;
	body: string;
} {
	const firstNewline = content.indexOf("\n");
	if (firstNewline === -1) {
		return { title: content, body: "" };
	}
	return {
		title: content.slice(0, firstNewline).trim(),
		body: content.slice(firstNewline + 1).trim(),
	};
}

async function submitPost(
	accessToken: string,
	params: Record<string, string>,
): Promise<RedditSubmitResponse> {
	// Reddit API: Submit a new post (link, self, image, etc.)
	// https://www.reddit.com/dev/api/#POST_api_submit
	const res = await redditFetch(`${REDDIT_API}/api/submit`, accessToken, {
		method: "POST",
		body: new URLSearchParams(params).toString(),
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => res.statusText);
		throw new Error(`Reddit submit failed: ${errText}`);
	}

	return res.json() as Promise<RedditSubmitResponse>;
}

export const redditPublisher: Publisher = {
	platform: "reddit",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const accessToken = request.account.access_token;
			const opts = request.target_options;

			// Subreddit is required
			const subreddit = opts.subreddit as string | undefined;
			if (!subreddit) {
				return {
					success: false,
					error: {
						code: "SUBREDDIT_REQUIRED",
						message: "Reddit requires a subreddit in target_options.",
					},
				};
			}

			// Strip r/ prefix if provided
			const sr = subreddit.replace(/^r\//, "");

			// Resolve content
			const content = (opts.content as string) ?? request.content ?? "";

			// Resolve title — from target_options or first line of content
			let title = opts.title as string | undefined;
			let body = content;

			if (!title) {
				const parsed = extractTitleAndBody(content);
				title = parsed.title;
				body = parsed.body;
			}

			if (!title) {
				return {
					success: false,
					error: {
						code: "TITLE_REQUIRED",
						message:
							"Reddit requires a title. Provide it in target_options.title or as the first line of content.",
					},
				};
			}

			// Validate title length
			if (title.length > 300) {
				return {
					success: false,
					error: {
						code: "TITLE_TOO_LONG",
						message: `Title is ${title.length} characters. Reddit limit is 300.`,
					},
				};
			}

			// Resolve media
			const media =
				(opts.media as Array<{ url: string; type?: string }>) ?? request.media;

			// URL for link posts
			const url = opts.url as string | undefined;
			const forceSelf = opts.force_self as boolean | undefined;

			// Flair
			const flairId = opts.flair_id as string | undefined;

			// Determine post kind and build params
			const params: Record<string, string> = {
				sr,
				title,
				api_type: "json",
				resubmit: "true",
				validate_on_submit: "true",
			};

			if (flairId) {
				params.flair_id = flairId;
			}

			if (opts.nsfw) params.nsfw = "true";
			if (opts.spoiler) params.spoiler = "true";

			// Decide post kind
			if (forceSelf) {
				// Force self post — put URL in body if present
				params.kind = "self";
				params.text = url ? `${body}\n\n${url}` : body;
			} else if (media.length === 1 && !url && media[0]?.type === "video") {
				// Single video — upload to Reddit's hosting, submit as kind: "video"
				const mediaUrl = media[0]?.url ?? "";
				try {
					const { filename, mimetype } = inferMediaInfo(mediaUrl);
					const uploaded = await uploadMediaAsset(
						accessToken,
						mediaUrl,
						filename,
						mimetype,
					);
					params.kind = "video";
					params.url = uploaded.url;

					// Reddit requires a video_poster_url (thumbnail)
					const thumbnailUrl = (opts.thumbnail_url as string) ?? (opts.video_poster_url as string);
					if (thumbnailUrl) {
						const thumbInfo = inferMediaInfo(thumbnailUrl);
						const thumbUploaded = await uploadMediaAsset(
							accessToken,
							thumbnailUrl,
							thumbInfo.filename,
							thumbInfo.mimetype,
						);
						params.video_poster_url = thumbUploaded.url;
					}
				} catch {
					// Fallback to link post if native upload fails
					params.kind = "link";
					params.url = mediaUrl;
				}
			} else if (media.length === 1 && !url && media[0]?.type !== "video") {
				// Single image — upload to Reddit's hosting via /api/media/asset.json
				// then submit as kind: "image" with the Reddit-hosted URL.
				const mediaUrl = media[0]?.url ?? "";
				try {
					const { filename, mimetype } = inferMediaInfo(mediaUrl);
					const uploaded = await uploadMediaAsset(
						accessToken,
						mediaUrl,
						filename,
						mimetype,
					);
					params.kind = "image";
					params.url = uploaded.url;
				} catch {
					// Fallback to link post if native upload fails
					params.kind = "link";
					params.url = mediaUrl;
				}
			} else if (media.length > 1) {
				// Gallery post — upload each image then use /api/submit_gallery_post.json
				try {
					const uploadedItems: Array<{
						mediaId: string;
						caption: string;
					}> = [];
					for (const item of media) {
						const { filename, mimetype } = inferMediaInfo(item.url);
						const uploaded = await uploadMediaAsset(
							accessToken,
							item.url,
							filename,
							mimetype,
						);
						uploadedItems.push({ mediaId: uploaded.assetId, caption: "" });
					}

					const galleryResult = await submitGalleryPost(
						accessToken,
						sr,
						title,
						uploadedItems,
						{
							flair_id: flairId,
							nsfw: opts.nsfw ? "true" : undefined,
							spoiler: opts.spoiler ? "true" : undefined,
						},
					);

					// Check for errors
					if (
						galleryResult.json.errors &&
						galleryResult.json.errors.length > 0
					) {
						const errors = galleryResult.json.errors
							.map((e) => `${e[0]}: ${e[1]}`)
							.join("; ");
						return {
							success: false,
							error: {
								code: "REDDIT_SUBMIT_ERROR",
								message: errors,
							},
						};
					}

					const galleryUrl = galleryResult.json.data?.url;
					const galleryId = galleryResult.json.data?.id;
					return {
						success: true,
						platform_post_id: galleryId,
						platform_url: galleryUrl,
					};
				} catch {
					// Fallback: self post with image URLs in body
					params.kind = "self";
					let galleryBody = body ? `${body}\n\n` : "";
					for (const item of media) {
						galleryBody += `${item.url}\n`;
					}
					params.text = galleryBody.trim();
				}
			} else if (url) {
				// Link post
				params.kind = "link";
				params.url = url;
			} else {
				// Text/self post
				params.kind = "self";
				params.text = body;
			}

			// Submit
			let result = await submitPost(accessToken, params);

			// Auto-retry: if link post fails in text-only subreddit, retry as self post
			if (
				params.kind === "link" &&
				result.json.errors.length > 0 &&
				result.json.errors.some((e) => e[0] === "NO_LINKS")
			) {
				params.kind = "self";
				params.text = body ? `${body}\n\n${params.url}` : (params.url ?? "");
				delete params.url;
				result = await submitPost(accessToken, params);
			}

			// Check for errors
			if (result.json.errors.length > 0) {
				const errors = result.json.errors
					.map((e) => `${e[0]}: ${e[1]}`)
					.join("; ");
				return {
					success: false,
					error: {
						code: "REDDIT_SUBMIT_ERROR",
						message: errors,
					},
				};
			}

			let postId = result.json.data?.name ?? result.json.data?.id;
			let postUrl = result.json.data?.url;

			// For media posts (image/video), Reddit returns a websocket_url
			// instead of the final post URL. Connect to get the real URL.
			const wsUrl = result.json.data?.websocket_url;
			if (wsUrl && (params.kind === "image" || params.kind === "video")) {
				try {
					const wsResult = await waitForRedditWebSocket(wsUrl);
					if (wsResult) {
						postId = wsResult.name;
						postUrl = wsResult.url;
					}
				} catch {
					// WebSocket failed — use whatever data we have from the submit response
				}
			}

			return {
				success: true,
				platform_post_id: postId,
				platform_url: postUrl,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
