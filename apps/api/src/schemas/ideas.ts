import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";
import { TagResponse } from "./tags";

// ── Idea Media ───────────────────────────────────────────────────────────────

export const IdeaMediaResponse = z.object({
	id: z.string().describe("Media ID"),
	url: z.string().describe("Media URL"),
	type: z
		.enum(["image", "video", "gif", "document"])
		.describe("Media type"),
	alt: z.string().nullable().describe("Alt text"),
	position: z.number().int().describe("Ordering position"),
});

// ── Idea Response ────────────────────────────────────────────────────────────

export const IdeaResponse = z.object({
	id: z.string().describe("Idea ID"),
	title: z.string().nullable().describe("Short title"),
	content: z.string().nullable().describe("Content/copy"),
	group_id: z.string().describe("Idea group (kanban column) ID"),
	position: z.number().describe("Position within group"),
	assigned_to: z.string().nullable().describe("Assigned user ID"),
	converted_to_post_id: z
		.string()
		.nullable()
		.describe("Post ID if converted (most recent)"),
	tags: z.array(TagResponse).describe("Associated tags"),
	media: z.array(IdeaMediaResponse).describe("Attached media"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// ── Create / Update ──────────────────────────────────────────────────────────

const CreateIdeaMediaItem = z.object({
	url: z
		.string()
		.url()
		.describe("Public URL of the uploaded media file (from POST /v1/media/upload)"),
	type: z
		.enum(["image", "video", "gif", "document"])
		.optional()
		.describe("Media type. Inferred from the URL extension if omitted."),
	alt: z.string().max(500).optional().describe("Alt text"),
});

export const CreateIdeaBody = z
	.object({
		title: z.string().max(500).optional().describe("Short title"),
		content: z.string().max(10000).optional().describe("Content/copy"),
		group_id: z
			.string()
			.optional()
			.describe("Idea group ID. If omitted, placed in default 'Unassigned' group."),
		tag_ids: z
			.array(z.string())
			.max(20)
			.optional()
			.describe("Tag IDs to associate"),
		assigned_to: z
			.string()
			.optional()
			.describe("User ID to assign this idea to"),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this idea to"),
		media: z
			.array(CreateIdeaMediaItem)
			.max(20)
			.optional()
			.describe(
				"Attach media by URL on create. Upload files to POST /v1/media/upload first, then pass the returned URLs here.",
			),
	})
	.describe("Create an idea");

export const UpdateIdeaBody = z
	.object({
		title: z.string().max(500).nullable().optional().describe("Short title"),
		content: z.string().max(10000).nullable().optional().describe("Content/copy"),
		assigned_to: z.string().nullable().optional().describe("User ID to assign"),
		tag_ids: z
			.array(z.string())
			.max(20)
			.optional()
			.describe("Replace all tag associations"),
	})
	.describe("Update an idea");

// ── Move ─────────────────────────────────────────────────────────────────────

export const MoveIdeaBody = z
	.object({
		group_id: z
			.string()
			.optional()
			.describe("Target group ID. Omit to reorder within current group."),
		position: z
			.number()
			.optional()
			.describe("Target position (float). Omit to place at end."),
		after_idea_id: z
			.string()
			.optional()
			.describe("Place after this idea. Takes precedence over position."),
	})
	.describe("Move an idea to a different group or position");

// ── Convert ──────────────────────────────────────────────────────────────────

export const ConvertIdeaBody = z
	.object({
		targets: z
			.array(
				z.object({
					account_id: z.string().describe("Social account ID"),
				}),
			)
			.min(1)
			.describe("Target social accounts"),
		scheduled_at: z
			.string()
			.optional()
			.describe('When to publish: ISO 8601 timestamp, "now", "draft", or "auto"'),
		timezone: z
			.string()
			.optional()
			.describe("IANA timezone for scheduling"),
		content: z
			.string()
			.optional()
			.describe("Override the idea content for the post"),
	})
	.describe("Convert an idea to a post. Content and media are pre-filled from the idea.");

// ── List Query ───────────────────────────────────────────────────────────────

export const IdeaListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
	group_id: z.string().optional().describe("Filter by idea group"),
	tag_id: z.string().optional().describe("Filter by tag"),
	assigned_to: z.string().optional().describe("Filter by assigned user"),
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const IdeaListResponse = paginatedResponse(IdeaResponse);

// ── Activity ─────────────────────────────────────────────────────────────────

export const IdeaActivityResponse = z.object({
	id: z.string().describe("Activity ID"),
	actor_id: z.string().describe("User who performed the action"),
	action: z
		.enum([
			"created", "moved", "assigned", "commented", "converted",
			"updated", "media_added", "media_removed", "tagged", "untagged",
		])
		.describe("Action type"),
	metadata: z
		.record(z.string(), z.unknown())
		.nullable()
		.describe("Action context"),
	created_at: z.string().datetime().describe("When the action occurred"),
});

export const IdeaActivityListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce.number().int().min(1).max(100).default(20).describe("Items per page"),
});

export const IdeaActivityListResponse = paginatedResponse(IdeaActivityResponse);

// ── Comments ─────────────────────────────────────────────────────────────────

export const IdeaCommentResponse = z.object({
	id: z.string().describe("Comment ID"),
	author_id: z.string().describe("Author user ID"),
	content: z.string().describe("Comment body"),
	parent_id: z.string().nullable().describe("Parent comment ID (for replies)"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const CreateIdeaCommentBody = z
	.object({
		content: z.string().min(1).max(5000).describe("Comment body"),
		parent_id: z.string().optional().describe("Parent comment ID to reply to"),
	})
	.describe("Add a comment to an idea");

export const UpdateIdeaCommentBody = z
	.object({
		content: z.string().min(1).max(5000).describe("Comment body"),
	})
	.describe("Edit a comment");

export const IdeaCommentListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce.number().int().min(1).max(100).default(20).describe("Items per page"),
});

export const IdeaCommentListResponse = paginatedResponse(IdeaCommentResponse);
