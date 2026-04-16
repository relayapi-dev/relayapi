import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const CreateTagBody = z
	.object({
		name: z.string().min(1).max(100).describe("Tag name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.describe("Hex color"),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this tag to"),
	})
	.describe("Create a tag");

export const UpdateTagBody = z
	.object({
		name: z.string().min(1).max(100).optional().describe("Tag name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.optional()
			.describe("Hex color"),
	})
	.describe("Update a tag");

export const TagResponse = z.object({
	id: z.string().describe("Tag ID"),
	name: z.string().describe("Tag name"),
	color: z.string().describe("Hex color"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const TagListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const TagListResponse = paginatedResponse(TagResponse);
