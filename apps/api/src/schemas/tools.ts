import { z } from "@hono/zod-openapi";
import { PlatformEnum } from "./common";
import { CreatePostBody } from "./posts";

function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// --- Validate post (dry-run) ---

export const ValidatePostBody = CreatePostBody;

export const ValidationError = z.object({
	target: z
		.string()
		.describe("Target identifier (account ID, platform, or field name)"),
	code: z.string().describe("Error code"),
	message: z.string().describe("Human-readable error message"),
});

export const ValidatePostResponse = z.object({
	valid: z.boolean().describe("Whether the post is valid for all targets"),
	errors: z.array(ValidationError).describe("Blocking errors"),
	warnings: z.array(ValidationError).describe("Non-blocking warnings"),
});

// --- Validate media URL ---

export const ValidateMediaBody = z.object({
	url: z
		.string()
		.url()
		.refine(isHttpOrHttpsUrl, "URL must use http or https")
		.describe("Media URL to validate"),
});

export const PlatformMediaLimit = z.object({
	within_limit: z.boolean().describe("Whether file size is within limit"),
	max_size: z.number().describe("Maximum file size in bytes"),
	mime_type_supported: z
		.boolean()
		.optional()
		.describe("Whether the MIME type is supported by this platform"),
});

export const ValidateMediaResponse = z.object({
	accessible: z.boolean().describe("Whether the URL is accessible"),
	content_type: z.string().nullable().optional().describe("MIME type"),
	size: z.number().nullable().optional().describe("File size in bytes"),
	platform_limits: z
		.record(PlatformEnum, PlatformMediaLimit)
		.describe("Per-platform size limits"),
});

// --- Post length checker ---

export const PostLengthBody = z.object({
	content: z.string().describe("Post content to check"),
});

export const PlatformCharCount = z.object({
	count: z.number().describe("Character count for this platform"),
	limit: z.number().describe("Character limit for this platform"),
	within_limit: z.boolean().describe("Whether content is within limit"),
});

export const PostLengthResponse = z.object({
	platforms: z
		.record(PlatformEnum, PlatformCharCount)
		.describe("Character count per platform"),
});

// --- Subreddit check ---

export const SubredditCheckQuery = z.object({
	name: z
		.string()
		.regex(/^[a-zA-Z0-9_]+$/, "Subreddit name must be alphanumeric or underscores only")
		.describe("Subreddit name (without r/ prefix)"),
});

export const SubredditCheckResponse = z.object({
	exists: z.boolean().describe("Whether the subreddit exists"),
	name: z.string().nullable().optional().describe("Canonical subreddit name"),
	title: z.string().nullable().optional().describe("Subreddit title"),
	subscribers: z.number().nullable().optional().describe("Subscriber count"),
	nsfw: z.boolean().nullable().optional().describe("Whether NSFW"),
	post_types: z
		.object({
			self: z.boolean().describe("Allows text posts"),
			link: z.boolean().describe("Allows link posts"),
			image: z.boolean().describe("Allows image posts"),
			video: z.boolean().optional().describe("Allows video posts"),
		})
		.optional()
		.describe("Allowed post types"),
});

// --- Hashtag checker ---

export const HashtagCheckBody = z.object({
	hashtags: z
		.array(z.string())
		.min(1)
		.max(50)
		.describe("Hashtags to check (without # prefix)"),
});

export const HashtagResult = z.object({
	hashtag: z.string().describe("Hashtag checked"),
	status: z
		.enum(["safe", "restricted", "banned"])
		.describe("Hashtag safety status"),
});

export const HashtagCheckResponse = z.object({
	results: z.array(HashtagResult),
});

// --- LinkedIn mention resolver ---

export const ResolveMentionBody = z.object({
	account_id: z.string().describe("LinkedIn account ID (for API access)"),
	type: z.enum(["organization", "person"]).describe("Entity type to resolve"),
	vanity_name: z
		.string()
		.optional()
		.describe("Vanity name (e.g. 'microsoft' for linkedin.com/company/microsoft)"),
	url: z
		.string()
		.url()
		.optional()
		.describe("Full LinkedIn URL (alternative to vanity_name)"),
});

export const ResolveMentionResponse = z.object({
	resolved: z.boolean().describe("Whether the entity was resolved"),
	urn: z.string().optional().describe("LinkedIn URN"),
	name: z.string().optional().describe("Entity name from LinkedIn"),
	mention_syntax: z
		.string()
		.optional()
		.describe("Ready-to-use mention syntax for post commentary"),
	error: z.string().optional().describe("Error message if not resolved"),
});

// --- Media Download ---

export const DownloadBody = z.object({
	url: z.string().url().describe("Public URL of the content to download"),
	format: z
		.enum(["best", "audio", "720p", "1080p", "4k"])
		.default("best")
		.describe("Desired format"),
});

export const DownloadFormat = z.object({
	format_id: z.string().describe("Format identifier"),
	ext: z.string().describe("File extension (mp4, webm, m4a, etc.)"),
	resolution: z.string().nullable().describe("Resolution (e.g. 1280x720)"),
	filesize: z.number().nullable().describe("File size in bytes"),
	url: z.string().describe("Direct download URL"),
});

export const DownloadResult = z.object({
	platform: z.string().describe("Platform name"),
	title: z.string().nullable().describe("Content title"),
	duration: z.number().nullable().describe("Duration in seconds"),
	thumbnail: z.string().nullable().describe("Thumbnail URL"),
	author: z.string().nullable().describe("Author/channel name"),
	formats: z.array(DownloadFormat).describe("Available download formats"),
	download_url: z.string().nullable().describe("Best match download URL"),
});

/** Sync success response (200) — result returned directly */
export const DownloadSyncResponse = DownloadResult.extend({
	success: z.literal(true),
});

/** Async accepted response (202) — job queued for processing */
export const ToolJobAcceptedResponse = z.object({
	job_id: z.string().describe("Job ID for polling"),
	status: z.literal("processing"),
	poll_url: z.string().describe("URL to poll for the result"),
});

/** Job polling response — union of processing, completed, and failed states */
export const ToolJobStatusResponse = z.object({
	job_id: z.string().describe("Job ID"),
	status: z.enum(["processing", "completed", "failed"]).describe("Current job status"),
	type: z.enum(["download", "transcript"]).optional().describe("Job type"),
	created_at: z.string().datetime().optional().describe("Job creation time"),
	completed_at: z.string().datetime().nullable().optional().describe("Job completion time"),
	result: z.record(z.string(), z.unknown()).nullable().optional().describe("Job result when completed"),
	error: z.string().nullable().optional().describe("Error message when failed"),
	error_code: z.string().nullable().optional().describe("Error code when failed"),
});

// --- YouTube Transcript ---

export const TranscriptBody = z.object({
	url: z.string().describe("YouTube video URL or video ID"),
	lang: z.string().optional().describe("Preferred language code (e.g. 'en', 'es')"),
});

export const TranscriptSegment = z.object({
	text: z.string().describe("Transcript text"),
	start: z.number().describe("Start time in seconds"),
	duration: z.number().describe("Duration in seconds"),
});

export const TranscriptResult = z.object({
	success: z.literal(true),
	video_id: z.string().describe("YouTube video ID"),
	language: z.string().nullable().describe("Transcript language"),
	is_auto_generated: z.boolean().nullable().describe("Whether auto-generated captions"),
	segments: z.array(TranscriptSegment).describe("Transcript segments with timestamps"),
	full_text: z.string().describe("Full concatenated transcript text"),
});
