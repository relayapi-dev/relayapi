import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { socialAccounts, generateId } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { PLATFORM_LIMITS, countChars } from "../config/platform-limits";
import type { Platform } from "../schemas/common";
import { PLATFORMS, ErrorResponse } from "../schemas/common";
import { callDownloaderService } from "../services/tool-service";
import { createToolJob, getToolJob } from "../services/tool-jobs";
import {
	HashtagCheckBody,
	HashtagCheckResponse,
	PostLengthBody,
	PostLengthResponse,
	ResolveMentionBody,
	ResolveMentionResponse,
	SubredditCheckQuery,
	SubredditCheckResponse,
	ValidateMediaBody,
	ValidateMediaResponse,
	ValidatePostBody,
	ValidatePostResponse,
	DownloadBody,
	DownloadSyncResponse,
	ToolJobAcceptedResponse,
	ToolJobStatusResponse,
	TranscriptBody,
	TranscriptResult,
} from "../schemas/tools";
import { escapeLinkedInCommentary } from "../publishers/linkedin";
import { resolveTargets } from "../services/target-resolver";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Route definitions ---

const validatePost = createRoute({
	operationId: "validatePost",
	method: "post",
	path: "/validate/post",
	tags: ["Tools"],
	summary: "Validate a post (dry-run without publishing)",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ValidatePostBody } },
		},
	},
	responses: {
		200: {
			description: "Validation result",
			content: { "application/json": { schema: ValidatePostResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const validateMedia = createRoute({
	operationId: "validateMedia",
	method: "post",
	path: "/validate/media",
	tags: ["Tools"],
	summary: "Validate a media URL for platform compatibility",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ValidateMediaBody } },
		},
	},
	responses: {
		200: {
			description: "Media validation result",
			content: {
				"application/json": { schema: ValidateMediaResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const validatePostLength = createRoute({
	operationId: "validatePostLength",
	method: "post",
	path: "/validate/post-length",
	tags: ["Tools"],
	summary: "Check character counts against platform limits",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: PostLengthBody } },
		},
	},
	responses: {
		200: {
			description: "Character count results",
			content: { "application/json": { schema: PostLengthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const checkSubreddit = createRoute({
	operationId: "checkSubreddit",
	method: "get",
	path: "/validate/subreddit",
	tags: ["Tools"],
	summary: "Check if a subreddit exists and get its details",
	security: [{ Bearer: [] }],
	request: { query: SubredditCheckQuery },
	responses: {
		200: {
			description: "Subreddit check result",
			content: {
				"application/json": { schema: SubredditCheckResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const checkHashtags = createRoute({
	operationId: "checkHashtags",
	method: "post",
	path: "/instagram/hashtag-checker",
	tags: ["Tools"],
	summary: "Check Instagram hashtag safety status",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: HashtagCheckBody } },
		},
	},
	responses: {
		200: {
			description: "Hashtag check results",
			content: {
				"application/json": { schema: HashtagCheckResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(validatePost, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const errors: Array<{ target: string; code: string; message: string }> = [];
	const warnings: Array<{ target: string; code: string; message: string }> = [];

	// Validate targets resolve correctly
	const { resolved, failed } = await resolveTargets(db, orgId, body.targets, c.get("workspaceScope"));

	for (const f of failed) {
		errors.push({
			target: f.key,
			code: f.error.code,
			message: f.error.message,
		});
	}

	// Validate content length per platform
	const content = body.content ?? "";
	for (const target of resolved) {
		const limits = PLATFORM_LIMITS[target.platform];
		if (!limits) continue;

		const charCount = countChars(content, target.platform);
		const maxChars = limits.chars.maxChars;

		if (charCount > maxChars) {
			errors.push({
				target: target.key,
				code: "CONTENT_TOO_LONG",
				message: `Content is ${charCount}/${maxChars} characters for ${target.platform}.`,
			});
		} else if (charCount > maxChars * 0.9) {
			warnings.push({
				target: target.key,
				code: "CONTENT_NEAR_LIMIT",
				message: `Content is ${charCount}/${maxChars} characters for ${target.platform}.`,
			});
		}
	}

	// Validate media count per platform
	const mediaItems = body.media ?? [];
	if (mediaItems.length > 0) {
		const images = mediaItems.filter(
			(m) => !m.type || m.type === "image" || m.type === "gif",
		);
		const videos = mediaItems.filter((m) => m.type === "video");

		for (const target of resolved) {
			const limits = PLATFORM_LIMITS[target.platform];
			if (!limits) continue;

			if (images.length > limits.media.maxImages && limits.media.maxImages > 0) {
				errors.push({
					target: target.key,
					code: "TOO_MANY_IMAGES",
					message: `${target.platform} allows max ${limits.media.maxImages} images, got ${images.length}.`,
				});
			}

			if (videos.length > limits.media.maxVideos) {
				errors.push({
					target: target.key,
					code: "TOO_MANY_VIDEOS",
					message: `${target.platform} allows max ${limits.media.maxVideos} videos, got ${videos.length}.`,
				});
			}

			if (limits.media.maxImages === 0 && images.length > 0 && videos.length === 0) {
				errors.push({
					target: target.key,
					code: "IMAGES_NOT_SUPPORTED",
					message: `${target.platform} requires video content.`,
				});
			}
		}
	}

	// Validate no content and no media
	if (!body.content && mediaItems.length === 0) {
		const hasTargetContent = body.target_options
			? Object.values(body.target_options).some(
					(opts) => "content" in (opts as Record<string, unknown>),
				)
			: false;

		if (!hasTargetContent) {
			errors.push({
				target: "_post",
				code: "EMPTY_POST",
				message:
					"Post must have content, media, or per-target content in target_options.",
			});
		}
	}

	return c.json(
		{
			valid: errors.length === 0,
			errors,
			warnings,
		},
		200,
	);
});

// @ts-expect-error — partial platform_limits record
app.openapi(validateMedia, async (c) => {
	const { url } = c.req.valid("json");

	let accessible = false;
	let contentType: string | null = null;
	let size: number | null = null;

	try {
		const response = await fetchPublicUrl(url, {
			method: "HEAD",
			timeout: 5_000,
		});
		accessible = response.ok;
		contentType = response.headers.get("Content-Type");
		const contentLength = response.headers.get("Content-Length");
		size = contentLength ? parseInt(contentLength, 10) : null;

		// Fallback to GET with Range header if HEAD failed or returned no size
		if (!accessible || size === null) {
			const getResponse = await fetchPublicUrl(url, {
				method: "GET",
				headers: { Range: "bytes=0-0" },
				timeout: 5_000,
			});
			if (getResponse.ok || getResponse.status === 206) {
				accessible = true;
				contentType = contentType ?? getResponse.headers.get("Content-Type");
				const contentRange = getResponse.headers.get("Content-Range");
				if (contentRange) {
					const match = contentRange.match(/\/(\d+)$/);
					if (match?.[1]) size = parseInt(match[1], 10);
				}
				if (size === null) {
					const cl = getResponse.headers.get("Content-Length");
					size = cl ? parseInt(cl, 10) : null;
				}
			}
		}
	} catch {
		accessible = false;
	}

	// Check against platform-specific limits
	const platformLimits: Record<
		string,
		{ within_limit: boolean; max_size: number; mime_type_supported?: boolean }
	> = {};

	if (accessible && size !== null) {
		const isVideo = contentType?.startsWith("video/") ?? false;
		const isGif = contentType === "image/gif";

		for (const platform of PLATFORMS) {
			const limits = PLATFORM_LIMITS[platform];

			// Use GIF-specific limit when available, otherwise fall back to image limit
			const maxSize = isVideo
				? limits.media.maxVideoSize
				: isGif && limits.media.maxGifSize
					? limits.media.maxGifSize
					: limits.media.maxImageSize;

			// Check MIME type support
			let mimeTypeSupported: boolean | undefined;
			if (contentType) {
				const allowedTypes = isVideo
					? limits.media.allowedVideoTypes
					: limits.media.allowedImageTypes;
				mimeTypeSupported = allowedTypes.length > 0
					? allowedTypes.includes(contentType)
					: undefined;
			}

			platformLimits[platform] = {
				within_limit: size <= maxSize,
				max_size: maxSize,
				mime_type_supported: mimeTypeSupported,
			};
		}
	}

	return c.json(
		{
			accessible,
			content_type: contentType,
			size,
			platform_limits: platformLimits,
		},
		200,
	);
});

// @ts-expect-error — partial platforms record
app.openapi(validatePostLength, async (c) => {
	const { content } = c.req.valid("json");

	const platforms: Record<
		string,
		{ count: number; limit: number; within_limit: boolean }
	> = {};

	for (const platform of PLATFORMS) {
		const limits = PLATFORM_LIMITS[platform];
		const charCount = countChars(content, platform);
		platforms[platform] = {
			count: charCount,
			limit: limits.chars.maxChars,
			within_limit: charCount <= limits.chars.maxChars,
		};
	}

	return c.json({ platforms }, 200);
});

app.openapi(checkSubreddit, async (c) => {
	const { name } = c.req.valid("query");

	try {
		// Reddit API: Get information about a subreddit
		// https://www.reddit.com/dev/api/#GET_r_{subreddit}_about
		const response = await fetch(
			`https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
			{
				headers: {
					"User-Agent": "web:RelayAPI:1.0 (by /u/relayapi)",
				},
			},
		);

		if (!response.ok) {
			return c.json(
				{
					exists: false,
					name,
					title: null,
					subscribers: null,
					nsfw: null,
					post_types: undefined,
				},
				200,
			);
		}

		const json = (await response.json()) as {
			data: {
				display_name: string;
				title: string;
				subscribers: number;
				over18: boolean;
				submission_type: string;
				allow_images: boolean;
				allow_videos: boolean;
			};
		};
		const data = json.data;

		return c.json(
			{
				exists: true,
				name: data.display_name,
				title: data.title,
				subscribers: data.subscribers,
				nsfw: data.over18,
				post_types: {
					self: data.submission_type !== "link",
					link: data.submission_type !== "self",
					image: data.allow_images ?? true,
					video: data.allow_videos ?? true,
				},
			},
			200,
		);
	} catch {
		return c.json(
			{
				exists: false,
				name,
				title: null,
				subscribers: null,
				nsfw: null,
				post_types: undefined,
			},
			200,
		);
	}
});

app.openapi(checkHashtags, async (c) => {
	const { hashtags } = c.req.valid("json");

	// NOTE: This is a static curated list. Instagram's actual banned/restricted
	// hashtag list changes frequently and is not available via a public API.
	// This provides a basic safety check, not comprehensive coverage.
	const BANNED_HASHTAGS = new Set([
		"adult",
		"naked",
		"porn",
		"sex",
		"xxx",
		"nude",
		"nsfw",
	]);
	const RESTRICTED_HASHTAGS = new Set([
		"followforfollow",
		"like4like",
		"f4f",
		"l4l",
		"followback",
		"instalike",
		"instadaily",
		"likeforfollow",
	]);

	return c.json(
		{
			results: hashtags.map((hashtag: string) => {
				const lower = hashtag.toLowerCase().replace(/^#/, "");
				if (BANNED_HASHTAGS.has(lower)) {
					return { hashtag, status: "banned" as const };
				}
				if (RESTRICTED_HASHTAGS.has(lower)) {
					return { hashtag, status: "restricted" as const };
				}
				return { hashtag, status: "safe" as const };
			}),
		},
		200,
	);
});

// --- LinkedIn mention resolver ---

const resolveMention = createRoute({
	operationId: "resolveLinkedInMention",
	method: "post",
	path: "/linkedin/resolve-mention",
	tags: ["Tools"],
	summary: "Resolve a LinkedIn entity to mention syntax",
	description:
		"Looks up a LinkedIn organization by vanity name and returns the URN and ready-to-use mention syntax for post commentary.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ResolveMentionBody } },
		},
	},
	responses: {
		200: {
			description: "Resolution result",
			content: {
				"application/json": { schema: ResolveMentionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(resolveMention, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Look up LinkedIn account for API access
	const [account] = await db
		.select({
			accessToken: socialAccounts.accessToken,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, body.account_id),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "linkedin"),
			),
		)
		.limit(1);

	if (!account?.accessToken) {
		return c.json(
			{ resolved: false, error: "LinkedIn account not found or missing access token" },
			200,
		);
	}

	// Workspace scope check
	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	// Parse vanity name from URL if provided
	let vanityName = body.vanity_name;
	if (!vanityName && body.url) {
		try {
			const parsed = new URL(body.url);
			const segments = parsed.pathname.split("/").filter(Boolean);
			if (segments[0] === "company" && segments[1]) {
				vanityName = segments[1];
			} else if (segments[0] === "in" && segments[1]) {
				vanityName = segments[1];
			}
		} catch {
			return c.json(
				{ resolved: false, error: "Invalid LinkedIn URL" },
				200,
			);
		}
	}

	if (!vanityName) {
		return c.json(
			{ resolved: false, error: "Either vanity_name or url is required" },
			200,
		);
	}

	if (body.type === "person") {
		return c.json(
			{
				resolved: false,
				error:
					"Person mention resolution is not supported. LinkedIn does not provide a public API to look up persons by vanity URL. Use the person's URN directly in mention syntax: @[Name](urn:li:person:ID)",
			},
			200,
		);
	}

	// Organization lookup via LinkedIn REST API
	// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
	try {
		const res = await fetch(
			`https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
			{
				headers: {
					Authorization: `Bearer ${await maybeDecrypt(account.accessToken, c.env.ENCRYPTION_KEY)}`,
					"Linkedin-Version": "202603",
					"X-Restli-Protocol-Version": "2.0.0",
				},
			},
		);

		if (!res.ok) {
			return c.json(
				{
					resolved: false,
					error: `LinkedIn API returned HTTP ${res.status}`,
				},
				200,
			);
		}

		const data = (await res.json()) as {
			elements?: Array<{
				id: number;
				localizedName?: string;
			}>;
		};

		const org = data.elements?.[0];
		if (!org) {
			return c.json(
				{ resolved: false, error: `Organization "${vanityName}" not found` },
				200,
			);
		}

		const urn = `urn:li:organization:${org.id}`;
		const name = org.localizedName ?? vanityName;
		const escapedName = escapeLinkedInCommentary(name);
		const mentionSyntax = `@[${escapedName}](${urn})`;

		return c.json(
			{
				resolved: true,
				urn,
				name,
				mention_syntax: mentionSyntax,
			},
			200,
		);
	} catch {
		return c.json(
			{ resolved: false, error: "Failed to connect to LinkedIn API" },
			200,
		);
	}
});

// --- Platform domain allowlists for download endpoints ---

const PLATFORM_DOMAINS: Record<string, string[]> = {
	youtube: ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"],
	tiktok: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "m.tiktok.com"],
	instagram: ["instagram.com", "www.instagram.com"],
	twitter: ["twitter.com", "www.twitter.com", "x.com", "www.x.com"],
	facebook: ["facebook.com", "www.facebook.com", "fb.watch", "m.facebook.com", "web.facebook.com"],
	linkedin: ["linkedin.com", "www.linkedin.com"],
	bluesky: ["bsky.app", "bsky.social"],
};

function isAllowedDomain(url: string, platform: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		const allowed = PLATFORM_DOMAINS[platform];
		if (!allowed) return false;
		return allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`));
	} catch {
		return false;
	}
}

// --- Shared download route factory ---

function createDownloadRoute(platform: string, summary: string) {
	return createRoute({
		operationId: `download${platform.charAt(0).toUpperCase() + platform.slice(1)}`,
		method: "post",
		path: `/${platform}/download`,
		tags: ["Tools"],
		summary,
		description: `Returns available formats and direct download URL. Responds with 200 if the result is ready immediately, or 202 with a job_id to poll if processing takes longer. Rate limited by daily tool quota.`,
		security: [{ Bearer: [] }],
		request: {
			body: { content: { "application/json": { schema: DownloadBody } } },
		},
		responses: {
			200: {
				description: "Download result (sync)",
				content: { "application/json": { schema: DownloadSyncResponse } },
			},
			202: {
				description: "Job accepted (async — poll /tools/jobs/{job_id})",
				content: { "application/json": { schema: ToolJobAcceptedResponse } },
			},
			400: {
				description: "Invalid URL or wrong platform",
				content: { "application/json": { schema: ErrorResponse } },
			},
			429: {
				description: "Daily tool limit exceeded",
				content: { "application/json": { schema: ErrorResponse } },
			},
		},
	});
}

async function handleDownload(
	c: any,
	platform: string,
) {
	const { url, format } = c.req.valid("json");
	const orgId = c.get("orgId");

	if (await isBlockedUrlWithDns(url)) {
		return c.json(
			{ error: { code: "INVALID_URL", message: "Private or localhost URLs are not allowed" } },
			400,
		);
	}

	if (!isAllowedDomain(url, platform)) {
		return c.json(
			{
				error: {
					code: "WRONG_PLATFORM",
					message: `URL does not belong to ${platform}. Expected domains: ${PLATFORM_DOMAINS[platform]?.join(", ")}`,
				},
			},
			400,
		);
	}

	// Try sync path: call Python VPS with 20s timeout
	const result = await callDownloaderService(
		c.env,
		"/download",
		{ url, platform, format },
		20_000,
	);

	if (result.ok) {
		return c.json({ success: true as const, ...result.data }, 200);
	}

	// If it was a real error (not timeout), return the error directly
	if (!("timedOut" in result) || !result.timedOut) {
		// Non-timeout failure — check if it's a content error vs service error
		if (result.error.includes("private") || result.error.includes("unavailable")) {
			return c.json(
				{ error: { code: "CONTENT_UNAVAILABLE", message: result.error } },
				404 as any,
			);
		}
		// Service not configured or down — fall through to queue
	}

	// Async fallback: enqueue to CF Queue
	const jobId = generateId("tj_");
	await createToolJob(c.env.KV, jobId, orgId, "download");

	await c.env.TOOLS_QUEUE.send({
		type: "tool_download",
		job_id: jobId,
		org_id: orgId,
		endpoint: "/download",
		payload: { url, platform, format },
	});

	return c.json(
		{
			job_id: jobId,
			status: "processing" as const,
			poll_url: `/v1/tools/jobs/${jobId}`,
		},
		202,
	);
}

// --- Download endpoints (7 platforms) ---

const downloadYoutube = createDownloadRoute("youtube", "Download YouTube video");
const downloadTiktok = createDownloadRoute("tiktok", "Download TikTok video");
const downloadInstagram = createDownloadRoute("instagram", "Download Instagram media");
const downloadTwitter = createDownloadRoute("twitter", "Download Twitter/X media");
const downloadFacebook = createDownloadRoute("facebook", "Download Facebook video");
const downloadLinkedin = createDownloadRoute("linkedin", "Download LinkedIn video");
const downloadBluesky = createDownloadRoute("bluesky", "Download Bluesky media");

app.openapi(downloadYoutube, (c) => handleDownload(c, "youtube"));
app.openapi(downloadTiktok, (c) => handleDownload(c, "tiktok"));
app.openapi(downloadInstagram, (c) => handleDownload(c, "instagram"));
app.openapi(downloadTwitter, (c) => handleDownload(c, "twitter"));
app.openapi(downloadFacebook, (c) => handleDownload(c, "facebook"));
app.openapi(downloadLinkedin, (c) => handleDownload(c, "linkedin"));
app.openapi(downloadBluesky, (c) => handleDownload(c, "bluesky"));

// --- YouTube Transcript ---

const getTranscript = createRoute({
	operationId: "getYoutubeTranscript",
	method: "post",
	path: "/youtube/transcript",
	tags: ["Tools"],
	summary: "Extract YouTube video transcript",
	description:
		"Extracts captions/subtitles from a YouTube video. Returns segments with timestamps and the full concatenated text. Responds with 200 if ready immediately, or 202 with a job_id to poll.",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: TranscriptBody } } },
	},
	responses: {
		200: {
			description: "Transcript result (sync)",
			content: { "application/json": { schema: TranscriptResult } },
		},
		202: {
			description: "Job accepted (async — poll /tools/jobs/{job_id})",
			content: { "application/json": { schema: ToolJobAcceptedResponse } },
		},
		400: {
			description: "Invalid URL",
			content: { "application/json": { schema: ErrorResponse } },
		},
		429: {
			description: "Daily tool limit exceeded",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — response union types
app.openapi(getTranscript, async (c) => {
	const { url, lang } = c.req.valid("json");
	const orgId = c.get("orgId");

	// Extract video ID from URL or treat as bare video ID
	let videoId = url;
	try {
		const parsed = new URL(url);
		const fromParam = parsed.searchParams.get("v");
		if (fromParam) {
			videoId = fromParam;
		} else if (parsed.hostname === "youtu.be") {
			videoId = parsed.pathname.slice(1);
		} else if (parsed.pathname.startsWith("/shorts/")) {
			videoId = parsed.pathname.split("/shorts/")[1]?.split("/")[0] ?? url;
		}
	} catch {
		// Not a URL — treat as bare video ID
	}

	// Try sync
	const result = await callDownloaderService(
		c.env,
		"/transcript",
		{ video_id: videoId, lang },
		20_000,
	);

	if (result.ok) {
		return c.json({ success: true as const, ...result.data }, 200);
	}

	if (!("timedOut" in result) || !result.timedOut) {
		if (result.error.includes("disabled") || result.error.includes("unavailable")) {
			return c.json(
				{ error: { code: "TRANSCRIPT_UNAVAILABLE", message: result.error } },
				404 as any,
			);
		}
	}

	// Async fallback
	const jobId = generateId("tj_");
	await createToolJob(c.env.KV, jobId, orgId, "transcript");

	await c.env.TOOLS_QUEUE.send({
		type: "tool_transcript",
		job_id: jobId,
		org_id: orgId,
		endpoint: "/transcript",
		payload: { video_id: videoId, lang },
	});

	return c.json(
		{
			job_id: jobId,
			status: "processing" as const,
			poll_url: `/v1/tools/jobs/${jobId}`,
		},
		202,
	);
});

// --- Job Polling ---

const getToolJobStatus = createRoute({
	operationId: "getToolJobStatus",
	method: "get",
	path: "/jobs/{job_id}",
	tags: ["Tools"],
	summary: "Poll for tool job result",
	description:
		"Check the status of an async tool job (download or transcript). Returns processing, completed with result, or failed with error.",
	security: [{ Bearer: [] }],
	request: {
		params: z.object({
			job_id: z.string().describe("Job ID returned from a download or transcript request"),
		}),
	},
	responses: {
		200: {
			description: "Job status",
			content: { "application/json": { schema: ToolJobStatusResponse } },
		},
		404: {
			description: "Job not found or expired",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getToolJobStatus, async (c) => {
	const { job_id } = c.req.valid("param");
	const job = await getToolJob(c.env.KV, job_id);

	if (!job) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Job not found or expired. Jobs are available for 1 hour after creation.",
				},
			},
			404,
		);
	}

	// Verify the job belongs to this org
	const orgId = c.get("orgId");
	if (job.org_id !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Job not found" } },
			404,
		);
	}

	if (job.status === "completed") {
		return c.json({
			job_id: job.job_id,
			status: job.status,
			type: job.type,
			created_at: job.created_at,
			completed_at: job.completed_at ?? null,
			result: job.result ?? null,
			error: null,
			error_code: null,
		}, 200);
	}

	if (job.status === "failed") {
		return c.json({
			job_id: job.job_id,
			status: job.status,
			type: job.type,
			created_at: job.created_at,
			completed_at: job.completed_at ?? null,
			result: null,
			error: job.error ?? null,
			error_code: job.error_code ?? null,
		}, 200);
	}

	return c.json({
		job_id: job.job_id,
		status: job.status,
		type: job.type,
		created_at: job.created_at,
		completed_at: null,
		result: null,
		error: null,
		error_code: null,
	}, 200);
});

export default app;
