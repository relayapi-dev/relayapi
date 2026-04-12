import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Field Definitions ---

export const CustomFieldType = z.enum([
	"text",
	"number",
	"date",
	"boolean",
	"select",
]);

export const CreateFieldBody = z.object({
	name: z.string().min(1).max(255).describe("Field name"),
	type: CustomFieldType.describe("Field type"),
	slug: z
		.string()
		.regex(/^[a-z0-9_]+$/, "Slug must be lowercase alphanumeric/underscores")
		.max(64)
		.optional()
		.describe("URL-safe identifier (auto-generated from name if omitted)"),
	options: z
		.array(z.string())
		.optional()
		.describe("Options for select type (required when type is select)"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this field to"),
});

export const UpdateFieldBody = z.object({
	name: z.string().min(1).max(255).optional().describe("Field name"),
	options: z
		.array(z.string())
		.optional()
		.describe("Options for select type"),
});

export const FieldResponse = z.object({
	id: z.string().describe("Field definition ID"),
	name: z.string().describe("Field name"),
	slug: z.string().describe("URL-safe identifier"),
	type: CustomFieldType.describe("Field type"),
	options: z.array(z.string()).nullable().optional().describe("Select options"),
	created_at: z.string().datetime().describe("Created timestamp"),
});

export const FieldListResponse = paginatedResponse(FieldResponse);

export const FieldIdParams = z.object({
	id: z.string().describe("Field definition ID"),
});

// --- Field Values ---

export const SetFieldValueBody = z.object({
	value: z.union([z.string(), z.number(), z.boolean()]).describe("Field value"),
});

export const FieldValueParams = z.object({
	contact_id: z.string().describe("Contact ID"),
	slug: z.string().describe("Field slug"),
});

export const SetFieldValueResponse = z.object({
	success: z.boolean(),
	field: z.string().describe("Field slug"),
	value: z.union([z.string(), z.number(), z.boolean()]).describe("Stored value"),
});
