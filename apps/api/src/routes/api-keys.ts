import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	canManageOrganizationCredentials,
	DASHBOARD_SESSION_AUTHORITY_HEADER,
	hasCurrentDashboardCredentialPermissions,
	PRICING,
} from "@relayapi/config";
import {
	apikey,
	session as authSession,
	generateId,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization,
	organizationPrincipals,
	principalWorkspaceGrants,
	user,
	workspaces,
} from "@relayapi/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import { hashKey, kvTtlForKey } from "../middleware/auth";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	requireAllWorkspaceScopeMiddleware,
	requireManageApiKeysMiddleware,
	requireWriteAccessMiddleware,
} from "../middleware/permissions";
import {
	ApiKeyCreatedResponse,
	ApiKeyListResponse,
	CreateApiKeyBody,
} from "../schemas/api-keys";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import type { Env, KVKeyData, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

class ApiKeyIssuerAuthorizationError extends Error {
	constructor(
		readonly status: 401 | 403,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiKeyIssuerAuthorizationError";
	}
}

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

function hasActiveBan(
	value: { banned: boolean | null; banExpires: Date | null },
	now = new Date(),
): boolean {
	return (
		value.banned === true &&
		(value.banExpires === null || value.banExpires > now)
	);
}

function createdByPrincipalId(metadata: unknown): string | null {
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata)
	) {
		return null;
	}
	const value = (metadata as Record<string, unknown>).created_by_principal_id;
	return typeof value === "string" ? value : null;
}

function hasApiKeyManagementAuthority(
	permissions: string | null | undefined,
): boolean {
	const livePermissions = new Set(
		(permissions ?? "")
			.split(",")
			.map((permission) => permission.trim())
			.filter(Boolean),
	);
	return livePermissions.has("write") && livePermissions.has("manage_api_keys");
}

function roleIncludesOwner(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.some((candidate) => candidate.trim() === "owner");
}

app.use("*", requireWriteAccessMiddleware);
app.use("*", requireAllWorkspaceScopeMiddleware);
app.use("*", requireManageApiKeysMiddleware);

function generateRawKey(): string {
	const bytes = new Uint8Array(29);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `rlay_live_${hex}`;
}

// --- Route definitions ---

const listApiKeys = createRoute({
	operationId: "listApiKeys",
	method: "get",
	path: "/",
	tags: ["API Keys"],
	summary: "List API keys",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "List of API keys",
			content: { "application/json": { schema: ApiKeyListResponse } },
		},
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "API-key administration permission required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createApiKey = createRoute({
	operationId: "createApiKey",
	method: "post",
	path: "/",
	tags: ["API Keys"],
	summary: "Create an API key",
	description:
		"Create a new API key. The full key is returned only once in the response — store it securely.",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateApiKeyBody } } },
	},
	responses: {
		201: {
			description: "API key created",
			content: {
				"application/json": { schema: ApiKeyCreatedResponse },
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
			description: "Organization owner scope grant required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteApiKey = createRoute({
	operationId: "deleteApiKey",
	method: "delete",
	path: "/{id}",
	tags: ["API Keys"],
	summary: "Delete an API key",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "API key deleted" },
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

app.openapi(listApiKeys, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: ReturnType<typeof decodeTimestampIdCursor> | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const conditions = [
		eq(apikey.organizationId, orgId),
		eq(organizationPrincipals.kind, "service"),
	];
	if (decodedCursor) {
		conditions.push(
			sql`(${apikey.createdAt}, ${apikey.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const keys = await db
		.select({
			id: apikey.id,
			name: apikey.name,
			start: apikey.start,
			prefix: apikey.prefix,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			createdAt: apikey.createdAt,
			permissions: apikey.permissions,
			metadata: apikey.metadata,
			scopeMode: organizationPrincipals.scopeMode,
			workspaceIds: sql<string[]>`COALESCE(
				(
					SELECT jsonb_agg(grant_row.workspace_id ORDER BY grant_row.workspace_id)
					FROM ${principalWorkspaceGrants} AS grant_row
					WHERE grant_row.organization_id = ${apikey.organizationId}
						AND grant_row.principal_id = ${organizationPrincipals.id}
				),
				'[]'::jsonb
			)`,
			cursorTimestamp: sql<string>`to_char(${apikey.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(apikey)
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(apikey.createdAt), desc(apikey.id))
		.limit(limit + 1);

	const hasMore = keys.length > limit;
	const data = keys.slice(0, limit);

	return c.json(
		{
			data: data.map((k) => ({
				id: k.id,
				name: k.name ?? null,
				start: k.start ?? "",
				prefix: k.prefix ?? null,
				created_at: k.createdAt.toISOString(),
				created_by_principal_id: createdByPrincipalId(k.metadata),
				expires_at: k.expiresAt?.toISOString() ?? null,
				enabled: k.enabled ?? true,
				permission: (k.permissions?.includes("write") || !k.permissions
					? "read_write"
					: "read_only") as "read_write" | "read_only",
				workspace_scope:
					k.scopeMode === "all" ? ("all" as const) : k.workspaceIds,
				can_manage_api_keys:
					k.permissions?.includes("manage_api_keys") ?? false,
				can_view_billing: k.permissions?.includes("view_billing") ?? false,
				can_manage_billing: k.permissions?.includes("manage_billing") ?? false,
				can_manage_spend: k.permissions?.includes("manage_spend") ?? false,
			})),
			next_cursor: hasMore
				? (() => {
						const last = data.at(-1);
						return last
							? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
							: null;
					})()
				: null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(createApiKey, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Validate workspace IDs belong to the organization
	if (Array.isArray(body.workspace_scope)) {
		const existing = await db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.organizationId, orgId),
					inArray(workspaces.id, body.workspace_scope),
				),
			);
		if (existing.length !== body.workspace_scope.length) {
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
	}

	const delegatesElevatedScope =
		body.can_manage_api_keys ||
		body.can_view_billing ||
		body.can_manage_billing ||
		body.can_manage_spend;

	const rawKey = generateRawKey();
	const hashedKey = await hashKey(rawKey);
	const prefix = "rlay_live_";
	const start = rawKey.slice(0, 8);
	const keyId = generateId("key_");
	const principalId = generateId("prn_");
	const scopeMode = body.workspace_scope === "all" ? "all" : "selected";

	const expiresAt = body.expires_in_days
		? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000)
		: null;

	// Use plan from auth context (already resolved by auth middleware)
	const plan: "free" | "pro" = (c.get("plan") as "free" | "pro") ?? "free";
	const callsIncluded =
		plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;

	const permissionsArray =
		body.permission === "read_write"
			? [
					"read",
					"write",
					...(body.can_manage_api_keys ? ["manage_api_keys"] : []),
					...(body.can_view_billing ? ["view_billing"] : []),
					...(body.can_manage_billing ? ["manage_billing"] : []),
					...(body.can_manage_spend ? ["manage_spend"] : []),
				]
			: ["read"];

	const createdByPrincipal = c.get("principalId");
	try {
		await db.transaction(async (tx) => {
			if (c.get("principalType") === "dashboard_user") {
				const principalUserId = c.get("principalUserId");
				const presentedSessionId = c.req.header(
					DASHBOARD_SESSION_AUTHORITY_HEADER,
				);
				if (!principalUserId || !presentedSessionId) {
					throw new ApiKeyIssuerAuthorizationError(
						401,
						"UNAUTHORIZED",
						"The API-key issuer is no longer authorized.",
					);
				}

				// Keep this order aligned with dashboard credential issuance and
				// membership/organization retirement. Every mutable authority row is
				// locked before the durable service principal is inserted, so a role
				// change, ban, key revocation, or tenant deletion has a single winner.
				const [lockedDashboardUser] = await tx
					.select({
						id: user.id,
						banned: user.banned,
						banExpires: user.banExpires,
						credentialVersion: user.credentialVersion,
					})
					.from(user)
					.where(eq(user.id, principalUserId))
					.for("share")
					.limit(1);
				const [lockedDashboardMember] = await tx
					.select({ id: member.id, userId: member.userId, role: member.role })
					.from(member)
					.where(
						and(
							eq(member.organizationId, orgId),
							eq(member.userId, principalUserId),
						),
					)
					.for("share")
					.limit(1);
				const [lockedDashboardOrganization] = await tx
					.select({
						id: organization.id,
						lifecycleStatus: organization.lifecycleStatus,
					})
					.from(organization)
					.where(eq(organization.id, orgId))
					.for("share")
					.limit(1);
				const [lockedDashboardKey] = await tx
					.select({
						id: apikey.id,
						referenceId: apikey.referenceId,
						principalId: apikey.principalId,
						credentialVersion: apikey.credentialVersion,
						enabled: apikey.enabled,
						expiresAt: apikey.expiresAt,
						permissions: apikey.permissions,
					})
					.from(apikey)
					.where(
						and(
							eq(apikey.id, c.get("keyId")),
							eq(apikey.key, c.get("keyHash")),
							eq(apikey.organizationId, orgId),
							eq(apikey.principalId, createdByPrincipal),
						),
					)
					.for("share")
					.limit(1);
				const [lockedDashboardPrincipal] = await tx
					.select({
						id: organizationPrincipals.id,
						kind: organizationPrincipals.kind,
						memberId: organizationPrincipals.memberId,
						scopeMode: organizationPrincipals.scopeMode,
						lifecycleStatus: organizationPrincipals.lifecycleStatus,
					})
					.from(organizationPrincipals)
					.where(
						and(
							eq(organizationPrincipals.id, createdByPrincipal),
							eq(organizationPrincipals.organizationId, orgId),
						),
					)
					.for("share")
					.limit(1);
				const [lockedDashboardSession] = await tx
					.select({
						id: authSession.id,
						impersonatedBy: authSession.impersonatedBy,
						expiresAt: authSession.expiresAt,
					})
					.from(authSession)
					.where(
						and(
							eq(authSession.id, presentedSessionId),
							eq(authSession.userId, principalUserId),
							eq(authSession.activeOrganizationId, orgId),
							gt(authSession.expiresAt, sql`statement_timestamp()`),
						),
					)
					.for("share")
					.limit(1);
				const finalAuthorityTime = new Date();
				if (
					!lockedDashboardUser ||
					!lockedDashboardMember ||
					!lockedDashboardOrganization ||
					!lockedDashboardKey ||
					!lockedDashboardPrincipal ||
					!lockedDashboardSession ||
					lockedDashboardSession.impersonatedBy !== null ||
					lockedDashboardSession.expiresAt <= finalAuthorityTime ||
					lockedDashboardMember.userId !== principalUserId ||
					lockedDashboardOrganization.lifecycleStatus !== "active" ||
					lockedDashboardKey.referenceId !== principalUserId ||
					lockedDashboardKey.principalId !== createdByPrincipal ||
					lockedDashboardKey.enabled !== true ||
					(lockedDashboardKey.expiresAt !== null &&
						lockedDashboardKey.expiresAt <= finalAuthorityTime) ||
					lockedDashboardPrincipal.kind !== "member" ||
					lockedDashboardPrincipal.memberId !== lockedDashboardMember.id ||
					lockedDashboardPrincipal.scopeMode !== "all" ||
					lockedDashboardPrincipal.lifecycleStatus !== "active" ||
					hasActiveBan(lockedDashboardUser, finalAuthorityTime) ||
					normalizedCredentialVersion(lockedDashboardKey.credentialVersion) !==
						normalizedCredentialVersion(lockedDashboardUser.credentialVersion)
				) {
					throw new ApiKeyIssuerAuthorizationError(
						401,
						"UNAUTHORIZED",
						"The API-key issuer is no longer authorized.",
					);
				}
				if (
					!canManageOrganizationCredentials(lockedDashboardMember.role) ||
					!hasCurrentDashboardCredentialPermissions(
						lockedDashboardKey.permissions,
						lockedDashboardMember.role,
					) ||
					!hasApiKeyManagementAuthority(lockedDashboardKey.permissions)
				) {
					throw new ApiKeyIssuerAuthorizationError(
						403,
						"MANAGE_API_KEYS_REQUIRED",
						"The API-key issuer can no longer manage organization credentials.",
					);
				}
				if (
					delegatesElevatedScope &&
					!roleIncludesOwner(lockedDashboardMember.role)
				) {
					throw new ApiKeyIssuerAuthorizationError(
						403,
						"OWNER_SCOPE_GRANT_REQUIRED",
						"Only a current organization owner can delegate elevated or financial scopes.",
					);
				}
			} else {
				// Service issuers use a single deterministic lock order. The exact
				// bearer is locked first so delete/disable and creation cannot both
				// commit as though they won the same authority decision.
				const [lockedServiceKey] = await tx
					.select({
						id: apikey.id,
						referenceId: apikey.referenceId,
						principalId: apikey.principalId,
						enabled: apikey.enabled,
						expiresAt: apikey.expiresAt,
						permissions: apikey.permissions,
					})
					.from(apikey)
					.where(
						and(
							eq(apikey.id, c.get("keyId")),
							eq(apikey.key, c.get("keyHash")),
							eq(apikey.organizationId, orgId),
							eq(apikey.principalId, createdByPrincipal),
						),
					)
					.for("share")
					.limit(1);
				const [lockedServicePrincipal] = await tx
					.select({
						id: organizationPrincipals.id,
						kind: organizationPrincipals.kind,
						scopeMode: organizationPrincipals.scopeMode,
						lifecycleStatus: organizationPrincipals.lifecycleStatus,
					})
					.from(organizationPrincipals)
					.where(
						and(
							eq(organizationPrincipals.id, createdByPrincipal),
							eq(organizationPrincipals.organizationId, orgId),
						),
					)
					.for("share")
					.limit(1);
				const [lockedServiceOrganization] = await tx
					.select({
						id: organization.id,
						lifecycleStatus: organization.lifecycleStatus,
					})
					.from(organization)
					.where(eq(organization.id, orgId))
					.for("share")
					.limit(1);
				const finalAuthorityTime = new Date();

				if (
					!lockedServiceKey ||
					!lockedServicePrincipal ||
					!lockedServiceOrganization ||
					lockedServiceKey.referenceId !== null ||
					lockedServiceKey.principalId !== createdByPrincipal ||
					lockedServiceKey.enabled !== true ||
					(lockedServiceKey.expiresAt !== null &&
						lockedServiceKey.expiresAt <= finalAuthorityTime) ||
					lockedServicePrincipal.kind !== "service" ||
					lockedServicePrincipal.scopeMode !== "all" ||
					lockedServicePrincipal.lifecycleStatus !== "active" ||
					lockedServiceOrganization.lifecycleStatus !== "active"
				) {
					throw new ApiKeyIssuerAuthorizationError(
						401,
						"UNAUTHORIZED",
						"The API-key issuer is no longer authorized.",
					);
				}
				if (!hasApiKeyManagementAuthority(lockedServiceKey.permissions)) {
					throw new ApiKeyIssuerAuthorizationError(
						403,
						"MANAGE_API_KEYS_REQUIRED",
						"The API-key issuer can no longer manage organization credentials.",
					);
				}
				if (delegatesElevatedScope) {
					throw new ApiKeyIssuerAuthorizationError(
						403,
						"OWNER_SCOPE_GRANT_REQUIRED",
						"Only a current organization owner can delegate elevated or financial scopes.",
					);
				}
			}

			await tx.insert(organizationPrincipals).values({
				id: principalId,
				organizationId: orgId,
				kind: "service",
				serviceName: body.name,
				scopeMode,
			});
			if (Array.isArray(body.workspace_scope)) {
				await tx.insert(principalWorkspaceGrants).values(
					body.workspace_scope.map((workspaceId) => ({
						organizationId: orgId,
						principalId,
						workspaceId,
					})),
				);
			}
			await tx.insert(apikey).values({
				id: keyId,
				name: body.name,
				key: hashedKey,
				start,
				prefix,
				organizationId: orgId,
				// Better Auth owns referenceId as personal key ownership. Service keys
				// are organization credentials; creator attribution stays in metadata so
				// its built-in personal-key routes cannot mutate them later.
				referenceId: null,
				principalId,
				enabled: true,
				expiresAt,
				permissions: permissionsArray.join(","),
				metadata: {
					created_by_principal_id: createdByPrincipal,
				},
			});
		});
	} catch (error) {
		if (!(error instanceof ApiKeyIssuerAuthorizationError)) throw error;
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}

	// Write to KV for fast auth lookup
	const kvData: KVKeyData = {
		org_id: orgId,
		key_id: keyId,
		permissions: permissionsArray,
		workspace_scope: body.workspace_scope,
		principal_type: "service",
		principal_id: principalId,
		principal_user_id: null,
		expires_at: expiresAt?.toISOString() ?? null,
		plan,
		quota_mode: c.get("quotaMode"),
		calls_included: callsIncluded,
		billing_source: c.get("billingSource"),
		billable: c.get("billable"),
		billing_period_id: c.get("billingPeriodId"),
		ai_enabled: c.get("aiEnabled"),
		daily_tool_limit: c.get("dailyToolLimit"),
		// Carry the org's current billing period (from the creating request's auth
		// context) so a new key on a pro org keys usage on the Stripe window
		// immediately rather than the calendar-month fallback until first refresh.
		period_start: c.get("periodStart") ?? null,
		period_end: c.get("periodEnd") ?? null,
	};
	await c.env.KV.put(`apikey:${hashedKey}`, JSON.stringify(kvData), {
		expirationTtl: kvTtlForKey(expiresAt),
	});

	return c.json(
		{
			id: keyId,
			key: rawKey,
			name: body.name,
			prefix,
			created_at: new Date().toISOString(),
			created_by_principal_id: createdByPrincipal,
			expires_at: expiresAt?.toISOString() ?? null,
			permission: body.permission,
			workspace_scope: body.workspace_scope,
			can_manage_api_keys: body.can_manage_api_keys,
			can_view_billing: body.can_view_billing,
			can_manage_billing: body.can_manage_billing,
			can_manage_spend: body.can_manage_spend,
		},
		201,
	);
});

app.openapi(deleteApiKey, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [key] = await db
		.select({
			id: apikey.id,
			key: apikey.key,
			principalId: organizationPrincipals.id,
			principalKind: organizationPrincipals.kind,
		})
		.from(apikey)
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
			),
		)
		.where(and(eq(apikey.id, id), eq(apikey.organizationId, orgId)))
		.limit(1);

	if (!key) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "API key not found" } },
			404,
		);
	}
	if (key.principalKind === "member") {
		return c.json(
			{
				error: {
					code: "DASHBOARD_KEY_MANAGED_AUTOMATICALLY",
					message: "Dashboard session credentials cannot be deleted manually.",
				},
			},
			403,
		);
	}

	// Retire the authenticator and its live grants, but retain the disabled
	// principal as pseudonymous attribution for durable comments/activity.
	await db.transaction(async (tx) => {
		await tx
			.delete(apikey)
			.where(and(eq(apikey.id, key.id), eq(apikey.organizationId, orgId)));
		await tx
			.delete(principalWorkspaceGrants)
			.where(
				and(
					eq(principalWorkspaceGrants.organizationId, orgId),
					eq(principalWorkspaceGrants.principalId, key.principalId),
				),
			);
		await tx
			.update(organizationPrincipals)
			.set({
				lifecycleStatus: "disabled",
				disabledAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(organizationPrincipals.id, key.principalId),
					eq(organizationPrincipals.organizationId, orgId),
					eq(organizationPrincipals.kind, "service"),
				),
			);
	});

	// PostgreSQL is revocation authority. Invalidate its KV projection only
	// after the authoritative transaction; a concurrent stale hydrate is still
	// rejected by auth's live key/principal check.
	c.executionCtx.waitUntil(
		c.env.KV.delete(`apikey:${key.key}`).catch((error) => {
			console.error("[API Keys] Best-effort KV invalidation failed", {
				apiKeyId: key.id,
				error,
			});
		}),
	);

	return c.body(null, 204);
});

export default app;
