import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const CreateInviteTokenBody = z
	.object({
		scope: z
			.enum(["all", "workspaces"])
			.default("all")
			.describe("Access scope: 'all' for full org access, or 'workspaces' for specific workspaces"),
		workspace_ids: z
			.array(z.string().startsWith("ws_"))
			.min(1)
			.max(50)
			.optional()
			.describe("Workspace IDs to scope access to (required when scope is 'workspaces')"),
		role: z
			.enum(["owner", "admin", "member"])
			.default("member")
			.describe("Role to assign on acceptance"),
	})
	.refine(
		(data) => data.scope !== "workspaces" || (data.workspace_ids && data.workspace_ids.length > 0),
		{ message: "workspace_ids is required when scope is 'workspaces'", path: ["workspace_ids"] },
	);

export const InviteTokenCreatedResponse = z.object({
	id: z.string().describe("Invite token ID"),
	token: z.string().describe("Full invite token (shown once, store securely)"),
	invite_url: z.string().url().describe("Invite URL to share"),
	scope: z.enum(["all", "workspaces"]).describe("Access scope"),
	workspace_ids: z.array(z.string()).nullable().describe("Scoped workspace IDs"),
	role: z.enum(["owner", "admin", "member"]).describe("Role assigned on acceptance"),
	expires_at: z.string().datetime().describe("Expiration timestamp"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const InviteTokenResponse = z.object({
	id: z.string().describe("Invite token ID"),
	scope: z.enum(["all", "workspaces"]).describe("Access scope"),
	workspace_ids: z.array(z.string()).nullable().describe("Scoped workspace IDs"),
	role: z.enum(["owner", "admin", "member"]).describe("Role assigned on acceptance"),
	used: z.boolean().describe("Whether the token has been used"),
	expires_at: z.string().datetime().describe("Expiration timestamp"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const InviteTokenListResponse = paginatedResponse(InviteTokenResponse);
