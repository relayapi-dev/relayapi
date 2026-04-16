import { z } from "@hono/zod-openapi";

export const CreateIdeaGroupBody = z
	.object({
		name: z.string().min(1).max(200).describe("Group name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.optional()
			.describe("Hex color for column header"),
		position: z.number().optional().describe("Position (float). Defaults to end."),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this group to"),
	})
	.describe("Create an idea group (kanban column)");

export const UpdateIdeaGroupBody = z
	.object({
		name: z.string().min(1).max(200).optional().describe("Group name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.nullable()
			.optional()
			.describe("Hex color for column header"),
	})
	.describe("Update an idea group");

export const ReorderIdeaGroupsBody = z
	.object({
		groups: z
			.array(
				z.object({
					id: z.string().describe("Group ID"),
					position: z.number().describe("New position (float)"),
				}),
			)
			.min(1)
			.describe("Groups with new positions"),
	})
	.describe("Reorder idea groups");

export const IdeaGroupResponse = z.object({
	id: z.string().describe("Group ID"),
	name: z.string().describe("Group name"),
	position: z.number().describe("Position for ordering"),
	color: z.string().nullable().describe("Hex color"),
	is_default: z.boolean().describe("Whether this is the default group"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const IdeaGroupListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const IdeaGroupListResponse = z.object({
	data: z.array(IdeaGroupResponse),
});
