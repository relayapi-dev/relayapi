import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const ApiKeyResponse = z.object({
	id: z.string().describe("API key ID"),
	name: z.string().nullable().describe("API key name"),
	start: z.string().describe("First 8 characters of the key (preview)"),
	prefix: z.string().nullable().describe("Key prefix (e.g. rlay_live_)"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	expires_at: z.string().datetime().nullable().describe("Expiration timestamp"),
	enabled: z.boolean().describe("Whether the key is active"),
	permission: z
		.enum(["read_write", "read_only"])
		.describe("Permission level"),
	workspace_scope: z
		.union([z.literal("all"), z.array(z.string())])
		.describe("Workspace access: 'all' or array of workspace IDs"),
	can_manage_api_keys: z
		.boolean()
		.describe("Whether this key can create, list, and revoke API keys"),
});

export const ApiKeyCreatedResponse = z.object({
	id: z.string().describe("API key ID"),
	key: z.string().describe("Full API key (shown once, store securely)"),
	name: z.string().nullable().describe("API key name"),
	prefix: z.string().describe("Key prefix"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	expires_at: z.string().datetime().nullable().describe("Expiration timestamp"),
	permission: z
		.enum(["read_write", "read_only"])
		.describe("Permission level"),
	workspace_scope: z
		.union([z.literal("all"), z.array(z.string())])
		.describe("Workspace access: 'all' or array of workspace IDs"),
	can_manage_api_keys: z
		.boolean()
		.describe("Whether this key can create, list, and revoke API keys"),
});

export const CreateApiKeyBody = z
	.object({
		name: z.string().min(1).max(255).describe("Name for the API key"),
		expires_in_days: z
			.number()
			.int()
			.min(1)
			.max(365)
			.optional()
			.describe("Number of days until the key expires"),
		permission: z
			.enum(["read_write", "read_only"])
			.default("read_write")
			.describe("Permission level: read_write (default) or read_only"),
		workspace_scope: z
			.union([
				z.literal("all"),
				z.array(z.string().startsWith("ws_")).min(1).max(50),
			])
			.default("all")
			.describe(
				"Workspace access: 'all' for unrestricted, or array of workspace IDs",
			),
		can_manage_api_keys: z
			.boolean()
			.default(false)
			.describe(
				"Allow this key to administer organization API keys; requires read_write and workspace_scope='all'",
			),
	})
	.superRefine((value, context) => {
		if (
			value.can_manage_api_keys &&
			(value.permission !== "read_write" || value.workspace_scope !== "all")
		) {
			context.addIssue({
				code: "custom",
				path: ["can_manage_api_keys"],
				message:
					"API-key management requires read_write permission and workspace_scope='all'",
			});
		}
	});

export const ApiKeyListResponse = paginatedResponse(ApiKeyResponse);
