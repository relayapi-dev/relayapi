import { z } from "@hono/zod-openapi";
import { INVITE_TOKEN_ROLES } from "@relayapi/db";
import { paginatedResponse } from "./common";

export const InviteTokenRoleSchema = z.enum(INVITE_TOKEN_ROLES);

export const CreateInviteTokenBody = z
	.object({
		scope_mode: z
			.enum(["all", "selected"])
			.default("all")
			.describe("Access scope: all workspaces or an exact selected set"),
		workspace_ids: z
			.array(z.string().startsWith("ws_"))
			.min(1)
			.max(50)
			.optional()
			.describe("Workspace IDs to grant (required for selected scope)"),
		role: InviteTokenRoleSchema.default("member").describe(
			"Role to assign on acceptance",
		),
	})
	.superRefine((data, context) => {
		if (data.scope_mode === "selected" && !data.workspace_ids?.length) {
			context.addIssue({
				code: "custom",
				message: "workspace_ids is required when scope_mode is 'selected'",
				path: ["workspace_ids"],
			});
		}
		if (data.scope_mode === "all" && data.workspace_ids !== undefined) {
			context.addIssue({
				code: "custom",
				message: "workspace_ids must be omitted when scope_mode is 'all'",
				path: ["workspace_ids"],
			});
		}
		if (
			data.workspace_ids &&
			new Set(data.workspace_ids).size !== data.workspace_ids.length
		) {
			context.addIssue({
				code: "custom",
				message: "workspace_ids must not contain duplicates",
				path: ["workspace_ids"],
			});
		}
	});

export const InviteTokenCreatedResponse = z.object({
	id: z.string().describe("Invite token ID"),
	token: z.string().describe("Full invite token (shown once, store securely)"),
	invite_url: z.string().url().describe("Invite URL to share"),
	scope_mode: z.enum(["all", "selected"]).describe("Access scope"),
	workspace_ids: z
		.array(z.string())
		.nullable()
		.describe("Scoped workspace IDs"),
	role: InviteTokenRoleSchema.describe("Role assigned on acceptance"),
	expires_at: z.string().datetime().describe("Expiration timestamp"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const InviteTokenResponse = z.object({
	id: z.string().describe("Invite token ID"),
	scope_mode: z.enum(["all", "selected"]).describe("Access scope"),
	workspace_ids: z
		.array(z.string())
		.nullable()
		.describe("Scoped workspace IDs"),
	role: InviteTokenRoleSchema.describe("Role assigned on acceptance"),
	used: z.boolean().describe("Whether the token has been used"),
	expires_at: z.string().datetime().describe("Expiration timestamp"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const InviteTokenListResponse = paginatedResponse(InviteTokenResponse);

export const RedeemInviteTokenBody = z
	.object({
		token: z
			.string()
			.regex(/^rlay_inv_[0-9a-f]{48}$/)
			.describe("Bearer invite token"),
	})
	.strict();

export const RedeemInviteTokenResponse = z.object({
	organization: z.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
	}),
	member: z.object({
		id: z.string(),
		role: InviteTokenRoleSchema,
	}),
	principal: z.object({
		id: z.string(),
		scope_mode: z.enum(["all", "selected"]),
		workspace_ids: z.array(z.string()).nullable(),
	}),
	redeemed_at: z.string().datetime(),
});
