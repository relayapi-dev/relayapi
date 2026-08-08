import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	apikey,
	generateId,
	inviteTokens,
	inviteTokenWorkspaces,
	member,
	organizationPrincipals,
	user,
	workspaces,
} from "@relayapi/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
	currentInviteIssuerCredentialVersion,
	isCurrentInviteIssuerCredential,
} from "../lib/invite-issuer-authority";
import { canAssignOrganizationRole } from "../lib/organization-roles";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateInviteTokenBody,
	InviteTokenCreatedResponse,
	InviteTokenListResponse,
} from "../schemas/invite";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

class InviteIssuerAuthorizationError extends Error {
	constructor(
		readonly status: 401 | 403,
		readonly code: "UNAUTHORIZED" | "FORBIDDEN",
		message: string,
	) {
		super(message);
		this.name = "InviteIssuerAuthorizationError";
	}
}

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
		"Create a single-use bearer invitation. Owner invitations expire within 24 hours; admin/member invitations expire within 7 days. The full token is returned only once.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateInviteTokenBody } },
		},
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
			scopeMode: inviteTokens.scopeMode,
			workspaceIds: sql<string[]>`COALESCE(
				(
					SELECT jsonb_agg(token_workspace.workspace_id ORDER BY token_workspace.workspace_id)
					FROM ${inviteTokenWorkspaces} AS token_workspace
					WHERE token_workspace.organization_id = ${inviteTokens.organizationId}
						AND token_workspace.invite_token_id = ${inviteTokens.id}
				),
				'[]'::jsonb
			)`,
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
				scope_mode: t.scopeMode,
				workspace_ids: t.scopeMode === "selected" ? t.workspaceIds : null,
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
	const body = c.req.valid("json");
	const db = c.get("db");
	const creatorPrincipalId = c.get("principalId");
	const creatorUserId = c.get("principalUserId");
	if (c.get("principalType") !== "dashboard_user") {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message:
						"Only an authenticated organization member can issue invitations",
				},
			},
			403,
		);
	}
	if (!creatorUserId) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "The invitation issuer is no longer authorized.",
				},
			},
			401,
		);
	}

	const rawToken = generateInviteToken();
	const hashedToken = await hashToken(rawToken);
	const tokenId = generateId("inv_");
	const createdAt = new Date();
	const expiryHours = body.role === "owner" ? 24 : 7 * 24;
	const expiresAt = new Date(
		createdAt.getTime() + expiryHours * 60 * 60 * 1000,
	);

	let created: boolean;
	try {
		created = await db.transaction(async (tx) => {
			// This shared lock is the serialization fence against the ban trigger's
			// user-row update. The same query also prevents the dashboard key,
			// principal, or membership from changing before the token is inserted.
			const [issuer] = await tx
				.select({
					keyId: apikey.id,
					keyReferenceId: apikey.referenceId,
					keyCredentialVersion: apikey.credentialVersion,
					keyExpiresAt: apikey.expiresAt,
					principalId: organizationPrincipals.id,
					principalKind: organizationPrincipals.kind,
					principalStatus: organizationPrincipals.lifecycleStatus,
					memberUserId: member.userId,
					memberRole: member.role,
					userId: user.id,
					userBanned: user.banned,
					userBanExpires: user.banExpires,
					userCredentialVersion: user.credentialVersion,
				})
				.from(apikey)
				.innerJoin(
					organizationPrincipals,
					and(
						eq(organizationPrincipals.id, apikey.principalId),
						eq(organizationPrincipals.organizationId, apikey.organizationId),
					),
				)
				.innerJoin(
					member,
					and(
						eq(member.id, organizationPrincipals.memberId),
						eq(member.organizationId, organizationPrincipals.organizationId),
					),
				)
				.innerJoin(user, eq(user.id, member.userId))
				.where(
					and(
						eq(apikey.id, c.get("keyId")),
						eq(apikey.organizationId, orgId),
						eq(apikey.principalId, creatorPrincipalId),
						eq(apikey.enabled, true),
					),
				)
				.for("share")
				.limit(1);
			const now = new Date();
			if (
				!issuer ||
				issuer.keyReferenceId !== creatorUserId ||
				issuer.principalKind !== "member" ||
				issuer.principalStatus !== "active" ||
				issuer.memberUserId !== creatorUserId ||
				issuer.userId !== creatorUserId ||
				(issuer.keyExpiresAt !== null && issuer.keyExpiresAt <= now) ||
				!isCurrentInviteIssuerCredential({
					issuedCredentialVersion: issuer.keyCredentialVersion,
					liveCredentialVersion: issuer.userCredentialVersion,
					banned: issuer.userBanned,
					banExpires: issuer.userBanExpires,
					now,
				})
			) {
				throw new InviteIssuerAuthorizationError(
					401,
					"UNAUTHORIZED",
					"The invitation issuer is no longer authorized.",
				);
			}
			if (!canAssignOrganizationRole(issuer.memberRole, body.role)) {
				throw new InviteIssuerAuthorizationError(
					403,
					"FORBIDDEN",
					"Cannot create an invitation with a higher role than the issuer's current role",
				);
			}

			if (body.scope_mode === "selected" && body.workspace_ids) {
				const existing = await tx
					.select({ id: workspaces.id })
					.from(workspaces)
					.where(
						and(
							eq(workspaces.organizationId, orgId),
							eq(workspaces.lifecycleStatus, "active"),
							inArray(workspaces.id, body.workspace_ids),
						),
					)
					.for("share");
				if (existing.length !== body.workspace_ids.length) return false;
			}

			await tx.insert(inviteTokens).values({
				id: tokenId,
				organizationId: orgId,
				createdBy: creatorUserId,
				createdByPrincipalId: creatorPrincipalId,
				issuerCredentialVersion: currentInviteIssuerCredentialVersion(
					issuer.userCredentialVersion,
				),
				tokenHash: hashedToken,
				scopeMode: body.scope_mode,
				role: body.role,
				expiresAt,
				createdAt,
			});
			if (body.scope_mode === "selected" && body.workspace_ids) {
				await tx.insert(inviteTokenWorkspaces).values(
					body.workspace_ids.map((workspaceId) => ({
						organizationId: orgId,
						inviteTokenId: tokenId,
						workspaceId,
					})),
				);
			}
			return true;
		});
	} catch (error) {
		if (!(error instanceof InviteIssuerAuthorizationError)) throw error;
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	if (!created) {
		return c.json(
			{
				error: {
					code: "INVALID_WORKSPACE",
					message:
						"One or more workspace IDs are invalid or do not belong to this organization.",
				},
			},
			400,
		);
	}

	const baseUrl =
		c.env.APP_BASE_URL ??
		c.env.API_BASE_URL?.replace("api.", "app.") ??
		"https://app.relayapi.dev";

	return c.json(
		{
			id: tokenId,
			token: rawToken,
			invite_url: `${baseUrl}/invite/${rawToken}`,
			scope_mode: body.scope_mode,
			workspace_ids:
				body.scope_mode === "selected" ? (body.workspace_ids ?? null) : null,
			role: body.role,
			expires_at: expiresAt.toISOString(),
			created_at: createdAt.toISOString(),
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
