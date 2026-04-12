import { z } from "@hono/zod-openapi";
import { ErrorResponse, paginatedResponse } from "./common";

function isHttpOrHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// --- Thread item in create body ---

const ThreadItem = z.object({
	content: z.string().min(1).describe("Post content for this thread item"),
	media: z
		.array(
			z.object({
				url: z
					.string()
					.url()
					.refine(isHttpOrHttpsUrl, "URL must use http or https")
					.describe("Public URL of the media file"),
				type: z
					.enum(["image", "video", "gif", "document"])
					.optional()
					.describe("Media type"),
			}),
		)
		.optional()
		.default([])
		.describe("Media attachments for this item"),
	delay_minutes: z
		.number()
		.int()
		.min(0)
		.max(1440)
		.default(0)
		.describe("Minutes to wait after the previous item is published before publishing this item (0-1440)"),
});

// --- Create thread body ---

export const CreateThreadBody = z.object({
	items: z
		.array(ThreadItem)
		.min(2)
		.max(25)
		.describe("Thread items in order. Minimum 2, maximum 25."),
	targets: z
		.array(z.string())
		.min(1)
		.describe('Account IDs, platform names, or workspace IDs'),
	scheduled_at: z
		.string()
		.refine(
			(val) => {
				if (val === "now" || val === "draft" || val === "auto") return true;
				const date = new Date(val);
				return !isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(val);
			},
			{
				message:
					'Must be "now", "draft", "auto", or a valid ISO 8601 timestamp',
			},
		)
		.describe('Publish intent'),
	target_options: z
		.record(z.string(), z.record(z.string(), z.any()))
		.optional()
		.describe("Per-platform options applied to all items"),
	timezone: z.string().default("UTC").describe("IANA timezone"),
	workspace_id: z.string().optional().describe("Workspace ID"),
});

// --- Thread item response ---

const ThreadItemTargetResult = z.object({
	platform: z.string(),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed", "skipped"]),
	platform_post_id: z.string().nullable(),
	platform_url: z.string().nullable(),
	error: z.string().nullable().optional(),
});

const ThreadItemResponse = z.object({
	id: z.string().describe("Post ID"),
	position: z.number().describe("Position within thread (0 = root)"),
	content: z.string().nullable(),
	media: z
		.array(
			z.object({
				url: z.string(),
				type: z.string().optional(),
			}),
		)
		.nullable(),
	delay_minutes: z.number().describe("Delay before this item in minutes"),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed", "partial"]),
	targets: z.record(z.string(), ThreadItemTargetResult).describe("Per-target results"),
});

// --- Thread response ---

export const ThreadResponse = z.object({
	thread_group_id: z.string().describe("Thread group identifier"),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed", "partial"]),
	items: z.array(ThreadItemResponse),
	scheduled_at: z.string().nullable(),
	timezone: z.string().nullable().optional(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

// --- Thread list item (summary) ---

const ThreadListItem = z.object({
	thread_group_id: z.string(),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed", "partial"]),
	item_count: z.number(),
	root_content: z.string().nullable().describe("Content of the first item"),
	scheduled_at: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const ThreadListResponse = paginatedResponse(ThreadListItem);

// --- Thread ID param ---

export const ThreadIdParam = z.object({
	thread_group_id: z.string().describe("Thread group ID"),
});

// --- Update thread body ---

export const UpdateThreadBody = z.object({
	items: z
		.array(
			z.object({
				id: z.string().optional().describe("Existing post ID (omit for new items)"),
				content: z.string().min(1),
				media: z
					.array(
						z.object({
							url: z.string().url(),
							type: z.enum(["image", "video", "gif", "document"]).optional(),
						}),
					)
					.optional()
					.default([]),
				delay_minutes: z.number().int().min(0).max(1440).default(0),
			}),
		)
		.min(2)
		.max(25)
		.optional()
		.describe("Updated thread items (replaces all items)"),
	scheduled_at: z
		.string()
		.refine(
			(val) => {
				if (val === "draft" || val === "auto") return true;
				const date = new Date(val);
				return !isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(val);
			},
			{
				message:
					'Must be "draft", "auto", or a valid ISO 8601 timestamp',
			},
		)
		.optional()
		.describe("Update schedule (cannot set to now on update)"),
});

// --- Thread list query ---

export const ThreadListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20),
	workspace_id: z.string().optional(),
	status: z.enum(["draft", "scheduled", "publishing", "published", "failed", "partial"]).optional(),
});
