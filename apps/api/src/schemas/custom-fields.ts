import { z } from "@hono/zod-openapi";
import { CUSTOM_FIELD_TYPES } from "@relayapi/db";
import { paginatedResponse } from "./common";

// --- Field Definitions ---

export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);

const CustomFieldOption = z.string().trim().min(1).max(255);

export const CreateFieldBody = z
	.object({
		name: z.string().min(1).max(255).describe("Field name"),
		type: CustomFieldType.describe("Field type"),
		slug: z
			.string()
			.regex(/^[a-z0-9_]+$/, "Slug must be lowercase alphanumeric/underscores")
			.max(64)
			.optional()
			.describe("URL-safe identifier (auto-generated from name if omitted)"),
		options: z
			.array(CustomFieldOption)
			.min(1)
			.optional()
			.describe("Non-empty options, required only for select fields"),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this field to"),
	})
	.superRefine((value, ctx) => {
		if (value.type === "select" && value.options === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["options"],
				message: "Options are required for select type",
			});
		}
		if (value.type !== "select" && value.options !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["options"],
				message: "Options are allowed only for select type",
			});
		}
	});

export const UpdateFieldBody = z.object({
	name: z.string().min(1).max(255).optional().describe("Field name"),
	options: z
		.array(CustomFieldOption)
		.min(1)
		.optional()
		.describe("Non-empty options for an existing select field"),
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
	value: z
		.union([z.string(), z.number(), z.boolean()])
		.describe("Stored value"),
});
