import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { apikey, createDb, generateId, inviteTokens, member, workspaces } from "@relayapi/db";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
	CreateInviteTokenBody,
	InviteTokenCreatedResponse,
	InviteTokenListResponse,
} from "../schemas/invite";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };

async function hashToken(token: string): Promise<string> {
	const encoded = new TextEncoder().encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function generateInviteToken(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `rlay_inv_${hex}`;
}

// --- Route definitions ---

const listInviteTokens = createRoute({
	operationId: "listInviteTokens",
	method: "get",
	path: "/",
	tags: ["Invite Tokens"],
	summary: "List invite tokens",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "List of invite tokens",
			content: { "application/json": { schema: InviteTokenListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createInviteToken = createRoute({
	operationId: "createInviteToken",
	method: "post",
	path: "/",
	tags: ["Invite Tokens"],
	summary: "Create an invite token",
	description:
		"Create a single-use invite token with a 7-day expiry. The full token is returned only once — store it securely.",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateInviteTokenBody } } },
	},
	responses: {
		201: {
			description: "Invite token created",
			content: {
				"application/json": { schema: InviteTokenCreatedResponse },
			},
		},
		400: {
			description: "Invalid request (e.g. invalid workspace IDs)",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden (role escalation)",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteInviteToken = createRoute({
	operationId: "deleteInviteToken",
	method: "delete",
	path: "/{id}",
	tags: ["Invite Tokens"],
	summary: "Revoke an invite token",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Invite token revoked" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(listInviteTokens, async (c) => {
	const orgId = c.get("orgId");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(inviteTokens.organizationId, orgId)];

	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: inviteTokens.createdAt })
			.from(inviteTokens)
			.where(eq(inviteTokens.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(lt(inviteTokens.createdAt, cursorRow.createdAt));
		}
	}

	const tokens = await db
		.select({
			id: inviteTokens.id,
			scope: inviteTokens.scope,
			scopedWorkspaceIds: inviteTokens.scopedWorkspaceIds,
			role: inviteTokens.role,
			used: inviteTokens.used,
			expiresAt: inviteTokens.expiresAt,
			createdAt: inviteTokens.createdAt,
		})
		.from(inviteTokens)
		.where(and(...conditions))
		.orderBy(desc(inviteTokens.createdAt))
		.limit(limit + 1);

	const hasMore = tokens.length > limit;
	const data = tokens.slice(0, limit);

	return c.json(
		{
			data: data.map((t) => ({
				id: t.id,
				scope: t.scope as "all" | "workspaces",
				workspace_ids: (t.scopedWorkspaceIds as string[]) ?? null,
				role: t.role as "owner" | "admin" | "member",
				used: t.used,
				expires_at: t.expiresAt.toISOString(),
				created_at: t.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(createInviteToken, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Resolve creator user ID from API key
	const [key] = await db
		.select({ referenceId: apikey.referenceId })
		.from(apikey)
		.where(eq(apikey.id, keyId))
		.limit(1);

	const creatorUserId = key?.referenceId;
	if (!creatorUserId) {
		return c.json(
			{ error: { code: "INVALID_KEY", message: "API key has no associated user" } },
			400,
		);
	}

	// Role escalation prevention
	const [creatorMember] = await db
		.select({ role: member.role })
		.from(member)
		.where(and(eq(member.userId, creatorUserId), eq(member.organizationId, orgId)))
		.limit(1);

	if (!creatorMember) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "You are not a member of this organization" } },
			403,
		);
	}

	const creatorRank = ROLE_RANK[creatorMember.role];
	if (creatorRank === undefined) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Your organization role is not recognized" } },
			403,
		);
	}

	const requestedRank = ROLE_RANK[body.role] ?? 0;
	if (requestedRank > creatorRank) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Cannot create invite with a higher role than your own" } },
			403,
		);
	}

	// Validate workspace IDs belong to the organization
	if (body.scope === "workspaces") {
		if (!body.workspace_ids?.length) {
			return c.json(
				{ error: { code: "BAD_REQUEST", message: "workspace_ids is required when scope is 'workspaces'" } },
				400,
			);
		}
	}
	if (body.scope === "workspaces" && body.workspace_ids) {
		const existing = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.organizationId, orgId),
					inArray(workspaces.id, body.workspace_ids),
				),
			);
		if (existing.length !== body.workspace_ids.length) {
			return c.json(
				{
					error: {
						code: "INVALID_WORKSPACE",
						message: "One or more workspace IDs are invalid or do not belong to this organization.",
					},
				},
				400,
			);
		}
	}

	const rawToken = generateInviteToken();
	const hashedToken = await hashToken(rawToken);
	const tokenId = generateId("inv_");
	const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

	await db.insert(inviteTokens).values({
		id: tokenId,
		organizationId: orgId,
		createdBy: creatorUserId,
		tokenHash: hashedToken,
		scope: body.scope,
		scopedWorkspaceIds: body.scope === "workspaces" ? (body.workspace_ids ?? null) : null,
		role: body.role,
		expiresAt,
	});

	const baseUrl = c.env.API_BASE_URL?.replace("api.", "app.") ?? "https://app.relayapi.dev";

	return c.json(
		{
			id: tokenId,
			token: rawToken,
			invite_url: `${baseUrl}/invite/${rawToken}`,
			scope: body.scope,
			workspace_ids: body.scope === "workspaces" ? (body.workspace_ids ?? null) : null,
			role: body.role,
			expires_at: expiresAt.toISOString(),
			created_at: new Date().toISOString(),
		},
		201,
	);
});

app.openapi(deleteInviteToken, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [token] = await db
		.select({ id: inviteTokens.id })
		.from(inviteTokens)
		.where(and(eq(inviteTokens.id, id), eq(inviteTokens.organizationId, orgId)))
		.limit(1);

	if (!token) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Invite token not found" } },
			404,
		);
	}

	await db.delete(inviteTokens).where(eq(inviteTokens.id, id));

	return c.body(null, 204);
});

export default app;
