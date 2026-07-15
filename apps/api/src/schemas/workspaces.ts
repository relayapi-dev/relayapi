import { z } from "@hono/zod-openapi";

export const WorkspaceResponse = z.object({
	id: z.string().describe("Workspace ID"),
	name: z.string().describe("Workspace name"),
	description: z.string().nullable().describe("Workspace description"),
	lifecycle_status: z
		.enum(["active", "archived", "erasing"])
		.describe("Workspace lifecycle state"),
	revision: z.number().int().nonnegative().describe("Concurrency revision"),
	archived_at: z.string().datetime().nullable(),
	erasure_requested_at: z.string().datetime().nullable(),
	account_ids: z
		.array(z.string())
		.describe("IDs of accounts in this workspace"),
	account_count: z.number().describe("Number of accounts in this workspace"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last updated timestamp"),
});

export const CreateWorkspaceBody = z.object({
	name: z.string().min(1).max(255).describe("Workspace name"),
	description: z
		.string()
		.max(1000)
		.optional()
		.describe("Workspace description"),
});

export const UpdateWorkspaceBody = z
	.object({
		name: z.string().min(1).max(255).optional().describe("Workspace name"),
		description: z
			.string()
			.max(1000)
			.nullable()
			.optional()
			.describe("Workspace description"),
		expected_revision: z
			.number()
			.int()
			.nonnegative()
			.describe("Revision returned by the latest workspace read"),
	})
	.strict();

export const WorkspaceLifecycleBody = z
	.object({
		expected_revision: z.number().int().nonnegative(),
	})
	.strict();

export const WorkspaceErasureRequestBody = WorkspaceLifecycleBody;

export const WorkspaceErasureResponse = z.object({
	workspace_id: z.string(),
	erasure_operation_id: z.string(),
	status: z.enum([
		"pending",
		"processing",
		"manual_review",
		"failed",
		"purged",
	]),
	requested_at: z.string().datetime(),
});

export const WorkspaceListQuery = z.object({
	search: z.string().optional().describe("Search workspaces by name"),
	lifecycle_status: z
		.enum(["active", "archived", "erasing", "all"])
		.default("active")
		.describe("Filter by lifecycle state; defaults to active"),
	limit: z.coerce.number().min(1).max(100).default(20).describe("Page size"),
	cursor: z.string().optional().describe("Pagination cursor"),
});

export const WorkspaceListResponse = z.object({
	data: z.array(WorkspaceResponse),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});
