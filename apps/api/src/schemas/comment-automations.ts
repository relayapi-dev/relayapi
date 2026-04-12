import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Comment Automation ---

export const CreateCommentAutomationBody = z.object({
	account_id: z.string().describe("Social account ID (Instagram or Facebook)"),
	platform: z.enum(["instagram", "facebook"]).describe("Platform"),
	post_id: z.string().optional().describe("Platform post/media ID (omit to apply to all posts)"),
	name: z.string().min(1).max(255).describe("Automation name"),
	keywords: z
		.array(z.string())
		.default([])
		.describe("Trigger keywords (empty = any comment)"),
	match_mode: z
		.enum(["contains", "exact"])
		.default("contains")
		.describe("Keyword matching mode"),
	dm_message: z.string().min(1).describe("DM text to send to commenter"),
	public_reply: z
		.string()
		.optional()
		.describe("Optional public reply to the comment"),
	once_per_user: z
		.boolean()
		.default(true)
		.describe("If true, each user only triggers this automation once"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this automation to"),
});

export const UpdateCommentAutomationBody = z.object({
	name: z.string().min(1).max(255).optional(),
	keywords: z.array(z.string()).optional(),
	match_mode: z.enum(["contains", "exact"]).optional(),
	dm_message: z.string().min(1).optional(),
	public_reply: z.string().nullable().optional(),
	once_per_user: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const CommentAutomationResponse = z.object({
	id: z.string().describe("Automation ID"),
	name: z.string(),
	platform: z.enum(["instagram", "facebook"]),
	account_id: z.string(),
	post_id: z.string().nullable(),
	enabled: z.boolean(),
	keywords: z.array(z.string()),
	match_mode: z.enum(["contains", "exact"]),
	dm_message: z.string(),
	public_reply: z.string().nullable().optional(),
	once_per_user: z.boolean(),
	stats: z.object({
		total_triggered: z.number(),
		last_triggered_at: z.string().datetime().nullable().optional(),
	}),
	created_at: z.string().datetime(),
});

export const CommentAutomationListResponse = paginatedResponse(
	CommentAutomationResponse,
);

export const CommentAutomationIdParams = z.object({
	id: z.string().describe("Comment automation ID"),
});

export const CommentAutomationLogEntry = z.object({
	id: z.string(),
	comment_id: z.string(),
	commenter_id: z.string(),
	commenter_name: z.string().nullable().optional(),
	comment_text: z.string().nullable().optional(),
	dm_sent: z.boolean(),
	reply_sent: z.boolean(),
	error: z.string().nullable().optional(),
	created_at: z.string().datetime(),
});

export const CommentAutomationLogListResponse = paginatedResponse(
	CommentAutomationLogEntry,
);
