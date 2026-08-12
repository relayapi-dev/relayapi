import { readProviderJson } from "../lib/provider-response";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { generateId, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { countChars, PLATFORM_LIMITS } from "../config/platform-limits";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import {
	getLinkedInRestHeaders,
	LINKEDIN_REST_BASE,
} from "../lib/linkedin-rest";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { escapeLinkedInCommentary } from "../publishers/linkedin";
import type { MediaAttachment } from "../publishers/types";
import { ErrorResponse, PLATFORMS } from "../schemas/common";
import {
	DownloadBody,
	DownloadSyncResponse,
	HashtagCheckBody,
	HashtagCheckResponse,
	PostLengthBody,
	PostLengthResponse,
	ResolveMentionBody,
	ResolveMentionResponse,
	SubredditCheckQuery,
	SubredditCheckResponse,
	ToolJobAcceptedResponse,
	ToolJobStatusResponse,
	TranscriptBody,
	TranscriptResult,
	ValidateMediaBody,
	ValidateMediaResponse,
	ValidatePostBody,
	ValidatePostResponse,
} from "../schemas/tools";
import {
	getPlatformContentLimit,
	getPlatformMediaFileLimit,
	resolvePlatformMediaForValidation,
	validatePlatformPostInput,
} from "../services/platform-post-validation";
import {
	hasEffectivePostPayload,
	resolvePostTargetOptions,
} from "../services/post-content-resolution";
import { resolveTargets } from "../services/target-resolver";
import {
	createToolJob,
	getToolJob,
	pollToolJobUntilTerminal,
	type ToolJob,
} from "../services/tool-jobs";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// Shared context for the download routes (all built by createDownloadRoute, so
// they share the same validated body). Responses are returned via `as never`
// so the shared helper slots into each route's typed response union.
type DownloadContext = Context<
	{ Bindings: Env; Variables: Variables },
	string,
	{
		in: { json: z.input<typeof DownloadBody> };
		out: { json: z.output<typeof DownloadBody> };
	}
>;

async function pollDurableToolJobForHttp(
	env: Env,
	jobId: string,
	organizationId: string,
): Promise<ToolJob | null> {
	try {
		return await pollToolJobUntilTerminal(env, jobId, organizationId);
	} catch (error) {
		// The Queue-owned row remains pollable. A transient read failure must not
		// discard its identifier or turn into a second provider attempt.
		console.warn("[tools] fast-result polling deferred", {
			event: "tool_job_fast_poll_deferred",
			organizationId,
			jobId,
			error,
		});
		return null;
	}
}

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
	const { resolved, failed } = await resolveTargets(
		db,
		orgId,
		body.targets,
		c.get("workspaceScope"),
	);

	for (const f of failed) {
		errors.push({
			target: f.key,
			code: f.error.code,
			message: f.error.message,
		});
	}

	const targetOptions = body.target_options as
		| Record<string, Record<string, unknown>>
		| undefined;
	const sharedContent = body.content ?? "";
	const sharedMedia = (body.media ?? []) as MediaAttachment[];
	for (const target of resolved) {
		const options = resolvePostTargetOptions(
			targetOptions ?? null,
			target.platform,
			target.key,
		);
		const content =
			typeof options.content === "string" && options.content.trim()
				? options.content
				: sharedContent;
		const media = resolvePlatformMediaForValidation(sharedMedia, options);
		const targetErrors = validatePlatformPostInput(
			target.platform,
			content,
			media,
			options,
		);
		for (const error of targetErrors) {
			errors.push({ target: target.key, ...error });
		}

		const lengthContent =
			typeof options.content_html === "string" ? options.content_html : content;
		const maxChars = getPlatformContentLimit(
			target.platform,
			media.length > 0,
			options,
		);
		const charCount = countChars(lengthContent, target.platform);
		if (charCount <= maxChars && charCount > maxChars * 0.9) {
			warnings.push({
				target: target.key,
				code: "CONTENT_NEAR_LIMIT",
				message: `Content is ${charCount}/${maxChars} characters for ${target.platform}.`,
			});
		}
	}

	// Validate no content and no media
	if (
		!hasEffectivePostPayload(body.content ?? null, body.media, targetOptions)
	) {
		errors.push({
			target: "_post",
			code: "EMPTY_POST",
			message:
				"Post must have content, media, or a supported per-target payload in target_options.",
		});
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
		for (const platform of PLATFORMS) {
			const { maxSize, mimeTypeSupported } = getPlatformMediaFileLimit(
				platform,
				contentType,
			);

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

		const json = (await readProviderJson(response)) as {
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
			id: socialAccounts.id,
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
			{
				resolved: false,
				error: "LinkedIn account not found or missing access token",
			},
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
			return c.json({ resolved: false, error: "Invalid LinkedIn URL" }, 200);
		}
	}

	if (!vanityName) {
		return c.json(
			{ resolved: false, error: "Either vanity_name or url is required" },
			200,
		);
	}
	const resolvedVanityName = vanityName;

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
	const accessToken = await decryptAccountToken(
		account.accessToken,
		c.env.ENCRYPTION_KEY,
		account.id,
		"access_token",
	);
	if (!accessToken) {
		return c.json(
			{
				resolved: false,
				error: "LinkedIn account not found or missing access token",
			},
			200,
		);
	}

	// Organization lookup via LinkedIn REST API
	// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
	try {
		const res = await fetch(
			`${LINKEDIN_REST_BASE}/organizations?q=vanityName&vanityName=${encodeURIComponent(resolvedVanityName)}`,
			{
				headers: getLinkedInRestHeaders(accessToken),
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

		const data = (await readProviderJson(res)) as {
			elements?: Array<{
				id: number;
				localizedName?: string;
			}>;
		};

		const org = data.elements?.[0];
		if (!org) {
			return c.json(
				{
					resolved: false,
					error: `Organization "${resolvedVanityName}" not found`,
				},
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
	youtube: [
		"youtube.com",
		"www.youtube.com",
		"youtu.be",
		"m.youtube.com",
		"music.youtube.com",
	],
	tiktok: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "m.tiktok.com"],
	instagram: ["instagram.com", "www.instagram.com"],
	twitter: ["twitter.com", "www.twitter.com", "x.com", "www.x.com"],
	facebook: [
		"facebook.com",
		"www.facebook.com",
		"fb.watch",
		"m.facebook.com",
		"web.facebook.com",
	],
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
			404: {
				description: "Content unavailable",
				content: { "application/json": { schema: ErrorResponse } },
			},
			429: {
				description: "Daily tool limit exceeded",
				content: { "application/json": { schema: ErrorResponse } },
			},
			502: {
				description: "Downloader provider failed after request start",
				content: { "application/json": { schema: ErrorResponse } },
			},
			504: {
				description: "Downloader provider outcome is unknown",
				content: { "application/json": { schema: ErrorResponse } },
			},
		},
	});
}

async function handleDownload(
	c: DownloadContext,
	platform: string,
): Promise<never> {
	const { url, format } = c.req.valid("json");
	const orgId = c.get("orgId");

	if (await isBlockedUrlWithDns(url)) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_URL",
					message: "Private or localhost URLs are not allowed",
				},
			},
			400,
		) as never;
	}

	if (!isAllowedDomain(url, platform)) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "WRONG_PLATFORM",
					message: `URL does not belong to ${platform}. Expected domains: ${PLATFORM_DOMAINS[platform]?.join(", ")}`,
				},
			},
			400,
		) as never;
	}

	// Every cost-bearing call becomes durable before Queue handoff. The HTTP
	// request only polls PostgreSQL for a fast result; it never performs a
	// second provider attempt or depends on waitUntil after returning 202.
	const usageReservation = c.get("toolUsageReservation");
	if (!usageReservation) {
		throw new Error("Tool usage reservation is unavailable");
	}
	const jobId = generateId("tj_");
	await createToolJob(c.env, jobId, orgId, "download", usageReservation.id, {
		url,
		platform,
		format,
	});
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
	c.set("toolUsageDisposition", "deferred");
	const job = await pollDurableToolJobForHttp(c.env, jobId, orgId);

	if (job?.status === "completed") {
		return c.json(
			{ success: true as const, ...(job.result ?? {}) },
			200,
		) as never;
	}
	if (job?.status === "failed") {
		const error = job.error ?? "Tool processing failed";
		if (job.error_code === "PROVIDER_OUTCOME_UNKNOWN") {
			return c.json(
				{
					error: {
						code: "PROVIDER_OUTCOME_UNKNOWN",
						message:
							"The downloader request timed out after it started. Retry explicitly if no result becomes available.",
					},
				},
				504,
			) as never;
		}
		if (error.includes("private") || error.includes("unavailable")) {
			return c.json(
				{ error: { code: "CONTENT_UNAVAILABLE", message: error } },
				404,
			) as never;
		}
		return c.json(
			{
				error: {
					code: "DOWNLOADER_PROVIDER_ERROR",
					message: error,
				},
			},
			502,
		) as never;
	}

	return c.json(
		{
			job_id: jobId,
			status: "processing" as const,
			poll_url: `/v1/tools/jobs/${jobId}`,
		},
		202,
	) as never;
}

// --- Download endpoints (7 platforms) ---

const downloadYoutube = createDownloadRoute(
	"youtube",
	"Download YouTube video",
);
const downloadTiktok = createDownloadRoute("tiktok", "Download TikTok video");
const downloadInstagram = createDownloadRoute(
	"instagram",
	"Download Instagram media",
);
const downloadTwitter = createDownloadRoute(
	"twitter",
	"Download Twitter/X media",
);
const downloadFacebook = createDownloadRoute(
	"facebook",
	"Download Facebook video",
);
const downloadLinkedin = createDownloadRoute(
	"linkedin",
	"Download LinkedIn video",
);
const downloadBluesky = createDownloadRoute(
	"bluesky",
	"Download Bluesky media",
);

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
		404: {
			description: "Transcript unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
		429: {
			description: "Daily tool limit exceeded",
			content: { "application/json": { schema: ErrorResponse } },
		},
		502: {
			description: "Transcript provider failed after request start",
			content: { "application/json": { schema: ErrorResponse } },
		},
		504: {
			description: "Transcript provider outcome is unknown",
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

	const usageReservation = c.get("toolUsageReservation");
	if (!usageReservation) {
		throw new Error("Tool usage reservation is unavailable");
	}
	const jobId = generateId("tj_");
	await createToolJob(c.env, jobId, orgId, "transcript", usageReservation.id, {
		video_id: videoId,
		lang,
	});
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
	c.set("toolUsageDisposition", "deferred");
	const job = await pollDurableToolJobForHttp(c.env, jobId, orgId);

	if (job?.status === "completed") {
		return c.json({ success: true as const, ...(job.result ?? {}) }, 200);
	}
	if (job?.status === "failed") {
		const error = job.error ?? "Transcript processing failed";
		if (job.error_code === "PROVIDER_OUTCOME_UNKNOWN") {
			return c.json(
				{
					error: {
						code: "PROVIDER_OUTCOME_UNKNOWN",
						message:
							"The transcript request timed out after it started. Retry explicitly if no result becomes available.",
					},
				},
				504,
			);
		}
		if (error.includes("disabled") || error.includes("unavailable")) {
			return c.json(
				{ error: { code: "TRANSCRIPT_UNAVAILABLE", message: error } },
				404,
			);
		}
		return c.json(
			{
				error: {
					code: "TRANSCRIPT_PROVIDER_ERROR",
					message: error,
				},
			},
			502,
		);
	}

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
			job_id: z
				.string()
				.describe("Job ID returned from a download or transcript request"),
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
	const orgId = c.get("orgId");
	const job = await getToolJob(c.env, job_id, orgId);

	if (!job) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message:
						"Job not found or expired. Terminal results are available for 1 hour.",
				},
			},
			404,
		);
	}

	if (job.status === "completed") {
		return c.json(
			{
				job_id: job.job_id,
				status: job.status,
				type: job.type,
				created_at: job.created_at,
				completed_at: job.completed_at ?? null,
				result: job.result ?? null,
				error: null,
				error_code: null,
			},
			200,
		);
	}

	if (job.status === "failed") {
		return c.json(
			{
				job_id: job.job_id,
				status: job.status,
				type: job.type,
				created_at: job.created_at,
				completed_at: job.completed_at ?? null,
				result: null,
				error: job.error ?? null,
				error_code: job.error_code ?? null,
			},
			200,
		);
	}

	return c.json(
		{
			job_id: job.job_id,
			status: job.status,
			type: job.type,
			created_at: job.created_at,
			completed_at: null,
			result: null,
			error: null,
			error_code: null,
		},
		200,
	);
});

export default app;
