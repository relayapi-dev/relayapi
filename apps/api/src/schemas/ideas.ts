import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";
import { TagResponse } from "./tags";

// ── Idea Media ───────────────────────────────────────────────────────────────

export const IdeaMediaResponse = z.object({
	id: z.string().describe("Idea attachment ID"),
	media_id: z.string().describe("Durable media-library row ID"),
	url: z
		.string()
		.url()
		.nullable()
		.describe("Presigned original URL, or durable thumbnail fallback"),
	thumbnail: z
		.string()
		.url()
		.nullable()
		.describe("Durable preview URL when available"),
	type: z.enum(["image", "video", "gif", "document"]).describe("Media type"),
	alt: z.string().nullable().describe("Alt text"),
	position: z.number().int().describe("Ordering position"),
	status: z
		.enum([
			"pending",
			"uploading",
			"upload_failed",
			"ready",
			"deleting",
			"deletion_failed",
		])
		.describe("Durable object lifecycle state"),
	original_available: z
		.boolean()
		.describe("Whether the full-resolution original is retained and ready"),
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
	revision: z
		.number()
		.int()
		.nonnegative()
		.describe("Optimistic concurrency revision"),
	tags: z.array(TagResponse).describe("Associated tags"),
	media: z.array(IdeaMediaResponse).describe("Attached media"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// ── Create / Update ──────────────────────────────────────────────────────────

export const CreateIdeaBody = z
	.object({
		title: z.string().max(500).optional().describe("Short title"),
		content: z.string().max(10000).optional().describe("Content/copy"),
		group_id: z
			.string()
			.optional()
			.describe(
				"Idea group ID. If omitted, placed in default 'Unassigned' group.",
			),
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
	})
	.describe(
		"Create an Idea. Upload owned attachments through POST /v1/ideas/{id}/media after creation.",
	);

export const UpdateIdeaBody = z
	.object({
		title: z.string().max(500).nullable().optional().describe("Short title"),
		content: z
			.string()
			.max(10000)
			.nullable()
			.optional()
			.describe("Content/copy"),
		assigned_to: z.string().nullable().optional().describe("User ID to assign"),
		tag_ids: z
			.array(z.string())
			.max(20)
			.optional()
			.describe("Replace all tag associations"),
		expected_revision: z
			.number()
			.int()
			.nonnegative()
			.describe("Revision returned by the last read"),
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
			.int()
			.nonnegative()
			.optional()
			.describe("Target 0-based position. Omit to place at end."),
		after_idea_id: z
			.string()
			.nullable()
			.optional()
			.describe(
				"Place after this Idea; null means first. Takes precedence over position.",
			),
		expected_revision: z
			.number()
			.int()
			.nonnegative()
			.describe("Revision returned by the last read"),
	})
	.describe("Move an idea to a different group or position");

// ── Convert ──────────────────────────────────────────────────────────────────

export const ConvertIdeaBody = z
	.object({
		idempotency_key: z
			.string()
			.min(8)
			.max(200)
			.describe("Stable key reused for retries of this conversion"),
		expected_revision: z
			.number()
			.int()
			.nonnegative()
			.describe("Revision returned by the last read"),
		timezone: z.string().optional().describe("IANA timezone for scheduling"),
		content: z
			.string()
			.optional()
			.describe("Override the idea content for the post"),
	})
	.describe(
		"Create exactly one draft from an Idea. Ready originals are copied; scheduling and targets are configured through the Posts API.",
	);

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
			"created",
			"moved",
			"assigned",
			"commented",
			"converted",
			"updated",
			"media_added",
			"media_removed",
			"tagged",
			"untagged",
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
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
});

export const IdeaActivityListResponse = paginatedResponse(IdeaActivityResponse);

// ── Comments ─────────────────────────────────────────────────────────────────

export const IdeaCommentResponse = z.object({
	id: z.string().describe("Comment ID"),
	author_id: z
		.string()
		.describe(
			"Actor ID who authored the comment. May be an API key ID (prefix 'key_') or a user ID.",
		),
	author: z
		.object({
			id: z.string().describe("User ID"),
			name: z.string().nullable().describe("Display name"),
			image: z.string().nullable().describe("Avatar URL"),
		})
		.nullable()
		.describe(
			"Resolved user info for the author. Null if the actor cannot be mapped to a user.",
		),
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
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
});

export const IdeaCommentListResponse = paginatedResponse(IdeaCommentResponse);
