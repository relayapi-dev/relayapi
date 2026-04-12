import { z } from "@hono/zod-openapi";

export const WorkspaceResponse = z.object({
	id: z.string().describe("Workspace ID"),
	name: z.string().describe("Workspace name"),
	description: z.string().nullable().describe("Workspace description"),
	account_ids: z.array(z.string()).describe("IDs of accounts in this workspace"),
	account_count: z.number().describe("Number of accounts in this workspace"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last updated timestamp"),
});

export const CreateWorkspaceBody = z.object({
	name: z.string().min(1).max(255).describe("Workspace name"),
	description: z.string().max(1000).optional().describe("Workspace description"),
});

export const UpdateWorkspaceBody = z.object({
	name: z.string().min(1).max(255).optional().describe("Workspace name"),
	description: z
		.string()
		.max(1000)
		.nullable()
		.optional()
		.describe("Workspace description"),
});

export const WorkspaceListQuery = z.object({
	search: z.string().optional().describe("Search workspaces by name"),
	limit: z.coerce.number().min(1).max(100).default(20).describe("Page size"),
	cursor: z.string().optional().describe("Pagination cursor"),
});

export const WorkspaceListResponse = z.object({
	data: z.array(WorkspaceResponse),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});
