import { z } from "@hono/zod-openapi";
import { PlatformEnum, paginatedResponse } from "./common";
import { CrossPostActionInput } from "./cross-post-actions";

function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// --- Media item in post body ---

const MediaItem = z.object({
	url: z
		.string()
		.url()
		.refine(isHttpOrHttpsUrl, "URL must use http or https")
		.describe("Public URL of the media file"),
	type: z
		.enum(["image", "video", "gif", "document"])
		.optional()
		.describe("Media type. Inferred from URL extension if omitted."),
});

// --- Scheduled at: "now" | "draft" | ISO timestamp ---

const MAX_SCHEDULE_DAYS = 30;

const ScheduledAt = z
	.string()
	.refine(
		(val) => {
			if (val === "now" || val === "draft" || val === "auto") return true;
			// Must be a valid ISO 8601 datetime
			const date = new Date(val);
			if (isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(val)) return false;
			// Must not be more than 30 days in the future
			const maxDate = new Date();
			maxDate.setDate(maxDate.getDate() + MAX_SCHEDULE_DAYS);
			return date <= maxDate;
		},
		{
			message: `Must be "now", "draft", "auto", or a valid ISO 8601 timestamp no more than ${MAX_SCHEDULE_DAYS} days in the future`,
		},
	)
	.describe(
		`Publish intent. Use "now" to publish immediately, "draft" to save as draft, "auto" to auto-schedule to the best available slot, or an ISO 8601 timestamp to schedule (max ${MAX_SCHEDULE_DAYS} days ahead).`,
	)
	.openapi({ example: "now" });

// --- Target: account ID (acc_*), platform name, or workspace ID (ws_*) ---

const Target = z
	.string()
	.describe(
		'Account ID (e.g. "acc_abc123"), platform name (e.g. "twitter"), or workspace ID (e.g. "ws_xxx"). Platform names resolve to all accounts on that platform. Workspace IDs resolve to all accounts in the workspace.',
	);

// --- Recycling config (inline on post create/update) ---

export const RecyclingInput = z.object({
	enabled: z.boolean().default(true).describe("Whether recycling is active"),
	gap: z.number().int().min(1).max(365).describe("Interval value"),
	gap_freq: z
		.enum(["day", "week", "month"])
		.describe("Interval unit"),
	start_date: z
		.string()
		.datetime({ offset: true })
		.describe("When to start recycling"),
	expire_count: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("Stop after this many recycles"),
	expire_date: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe("Stop after this date"),
	content_variations: z
		.array(z.string().max(5000))
		.max(20)
		.optional()
		.describe("Alternate content texts (round-robin)"),
});

export const RecyclingConfigResponse = z.object({
	id: z.string(),
	enabled: z.boolean(),
	gap: z.number(),
	gap_freq: z.enum(["day", "week", "month"]),
	start_date: z.string().datetime(),
	expire_count: z.number().nullable(),
	expire_date: z.string().datetime().nullable(),
	content_variations: z.array(z.string()),
	recycle_count: z.number(),
	content_variation_index: z.number(),
	next_recycle_at: z.string().datetime().nullable(),
	last_recycled_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

// --- Create post ---

export const CreatePostBody = z.object({
	content: z
		.string()
		.optional()
		.describe(
			"Post text. Optional if target_options provide per-target content.",
		),
	targets: z
		.array(Target)
		.min(1)
		.describe("Account IDs, platform names, or workspace IDs to publish to"),
	scheduled_at: ScheduledAt,
	media: z.array(MediaItem).optional().describe("Media attachments"),
	target_options: z
		.record(z.string(), z.record(z.string(), z.any()))
		.optional()
		.describe(
			"Per-target customizations keyed by target value (account ID or platform name). Supports platform-specific features such as Twitter polls (poll.options, poll.duration_minutes), threads, reply_to, and reply_settings.",
		),
	timezone: z.string().default("UTC").describe("IANA timezone for scheduling"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this post to"),
	recycling: RecyclingInput.optional().describe("Recycling configuration for evergreen content (Pro plan only)"),
	shorten_urls: z.boolean().optional().describe("Shorten URLs in post content. Only relevant when short link mode is 'ask'. Ignored when mode is 'always' or 'never'. (Pro plan only)"),
	cross_post_actions: z.array(CrossPostActionInput).optional().describe("Cross-post actions to execute after publishing (e.g., repost from another account, comment from another account)"),
	template_id: z.string().optional().describe("Content template ID. When provided, the template content is used as the base for the post. Explicit 'content' field takes precedence."),
	idea_id: z.string().optional().describe("Create post from an idea. Pre-fills content from the idea. Explicit 'content' field takes precedence."),
	template_variables: z.record(z.string(), z.string()).optional().describe("Variables to interpolate in the template (e.g., { \"promo_code\": \"SUMMER25\" }). Built-in variables: {{date}}, {{account_name}}."),
	skip_signature: z.boolean().optional().describe("When true, the default signature is not auto-appended even if one is configured."),
});

// --- Update post ---

export const UpdatePostBody = z.object({
	content: z.string().optional().describe("Post text"),
	notes: z.string().nullable().optional().describe("Internal notes for this post"),
	targets: z.array(Target).min(1).optional().describe("Updated targets"),
	scheduled_at: ScheduledAt.optional(),
	media: z.array(MediaItem).optional().describe("Updated media"),
	target_options: z
		.record(z.string(), z.record(z.string(), z.any()))
		.optional(),
	timezone: z.string().optional(),
	recycling: RecyclingInput.optional().describe("Recycling configuration (Pro plan only)"),
});

// --- Per-target status in response ---

const TargetAccountResult = z.object({
	id: z.string(),
	username: z.string().nullable(),
	display_name: z.string().nullable().describe("Account display name"),
	avatar_url: z.string().nullable().describe("Account avatar URL"),
	url: z.string().nullable().describe("Published post URL on the platform"),
	platform_post_id: z.string().nullable().describe("Platform-native post ID"),
});

const TargetResult = z.object({
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed"]),
	platform: PlatformEnum,
	accounts: z.array(TargetAccountResult).optional(),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
		})
		.optional(),
});

// --- Post response ---

export const MetricsSnapshot = z.object({
	impressions: z.number().optional(),
	reach: z.number().optional(),
	likes: z.number().optional(),
	comments: z.number().optional(),
	shares: z.number().optional(),
	saves: z.number().optional(),
	clicks: z.number().optional(),
	views: z.number().optional(),
	engagement_rate: z.number().optional(),
}).describe("Aggregated engagement metrics");

export const PostResponse = z.object({
	id: z.string().describe("Post ID"),
	status: z.enum([
		"draft",
		"scheduled",
		"publishing",
		"published",
		"failed",
		"partial",
	]),
	content: z.string().nullable(),
	scheduled_at: z.string().nullable(),
	published_at: z.string().nullable().describe("When the post was published"),
	targets: z.record(z.string(), TargetResult).describe("Per-target results"),
	media: z.array(MediaItem).nullable(),
	target_options: z.record(z.string(), z.record(z.string(), z.any())).nullable().optional().describe("Per-target customizations"),
	timezone: z.string().nullable().optional().describe("IANA timezone"),
	metrics: MetricsSnapshot.optional().describe("Engagement metrics (reactions, comments, views, etc.)"),
	recycling: RecyclingConfigResponse.nullable().describe("Recycling configuration, if any"),
	recycled_from_id: z.string().nullable().describe("Source post ID if this is a recycled copy"),
	thread_group_id: z.string().nullable().optional().describe("Thread group ID (non-null if part of a thread)"),
	thread_position: z.number().nullable().optional().describe("Position within thread (0 = root)"),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const PostListResponse = paginatedResponse(PostResponse);

// --- External post (fetched from platform, not created through RelayAPI) ---

export const ExternalPostItem = z.object({
	id: z.string().describe("External post ID"),
	source: z.literal("external"),
	platform: PlatformEnum,
	social_account_id: z.string(),
	platform_post_id: z.string(),
	platform_url: z.string().nullable(),
	content: z.string().nullable(),
	media_urls: z.array(z.string()),
	media_type: z.string().nullable(),
	thumbnail_url: z.string().nullable(),
	metrics: z.object({
		impressions: z.number().optional(),
		reach: z.number().optional(),
		likes: z.number().optional(),
		comments: z.number().optional(),
		shares: z.number().optional(),
		saves: z.number().optional(),
		clicks: z.number().optional(),
		views: z.number().optional(),
	}),
	published_at: z.string().datetime(),
	created_at: z.string().datetime(),
});

// --- Update metadata (published video) ---

export const UpdateMetadataBody = z.object({
	platform: z
		.literal("youtube")
		.describe("Platform to update metadata on (YouTube only for now)"),
	account_id: z
		.string()
		.optional()
		.describe("Account ID (required when post ID is '_' for direct video ID mode)"),
	video_id: z
		.string()
		.optional()
		.describe("YouTube video ID (required when post ID is '_' for direct mode)"),
	title: z.string().max(100).optional().describe("Video title (max 100 chars)"),
	description: z.string().max(5000).optional().describe("Video description"),
	tags: z.array(z.string().max(100)).optional().describe("Video tags"),
	visibility: z
		.enum(["public", "private", "unlisted"])
		.optional()
		.describe("Video visibility"),
	category_id: z.string().optional().describe("YouTube category ID"),
	made_for_kids: z.boolean().optional().describe("COPPA compliance flag"),
	playlist_id: z
		.string()
		.optional()
		.describe("YouTube playlist ID to add the video to"),
});

export const UpdateMetadataResponse = z.object({
	success: z.boolean(),
	platform: z.string(),
	video_id: z.string(),
	updated_fields: z.array(z.string()).describe("Fields that were updated"),
});

// --- Bulk CSV upload ---

export const BulkCsvRowResult = z.object({
	row: z.number().describe("1-based row number"),
	status: z.enum(["success", "error", "skipped"]),
	post_id: z
		.string()
		.optional()
		.describe("Created post ID (only on success)"),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
		})
		.optional(),
});

export const BulkCsvResponse = z.object({
	data: z.array(BulkCsvRowResult),
	summary: z.object({
		total_rows: z.number(),
		succeeded: z.number(),
		failed: z.number(),
		skipped: z.number().describe("Rows skipped in dry_run mode"),
		posts_created: z.number(),
	}),
});
