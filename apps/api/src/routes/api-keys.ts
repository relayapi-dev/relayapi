import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PRICING } from "@relayapi/config";
import { apikey, generateId, workspaces } from "@relayapi/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import { hashKey, kvTtlForKey } from "../middleware/auth";
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
		sql`${apikey.metadata}->>'principal_type' IS DISTINCT FROM 'dashboard_user'`,
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
			cursorTimestamp: sql<string>`to_char(${apikey.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(apikey)
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
				expires_at: k.expiresAt?.toISOString() ?? null,
				enabled: k.enabled ?? true,
				permission: (k.permissions?.includes("write") || !k.permissions
					? "read_write"
					: "read_only") as "read_write" | "read_only",
				workspace_scope:
					(k.metadata as Record<string, unknown>)?.workspace_scope ??
					("all" as "all" | string[]),
				can_manage_api_keys:
					k.permissions?.includes("manage_api_keys") ?? false,
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

	const rawKey = generateRawKey();
	const hashedKey = await hashKey(rawKey);
	const prefix = "rlay_live_";
	const start = rawKey.slice(0, 8);
	const keyId = generateId("key_");

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
				]
			: ["read"];

	await db.insert(apikey).values({
		id: keyId,
		name: body.name,
		key: hashedKey,
		start,
		prefix,
		organizationId: orgId,
		enabled: true,
		expiresAt,
		permissions: permissionsArray.join(","),
		metadata: {
			workspace_scope: body.workspace_scope,
			principal_type: "service",
			created_by_principal_id: c.get("principalId"),
		},
	});

	// Write to KV for fast auth lookup
	const kvData: KVKeyData = {
		org_id: orgId,
		key_id: keyId,
		permissions: permissionsArray,
		workspace_scope: body.workspace_scope,
		principal_type: "service",
		principal_id: null,
		expires_at: expiresAt?.toISOString() ?? null,
		plan,
		calls_included: callsIncluded,
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
			expires_at: expiresAt?.toISOString() ?? null,
			permission: body.permission,
			workspace_scope: body.workspace_scope,
			can_manage_api_keys: body.can_manage_api_keys,
		},
		201,
	);
});

app.openapi(deleteApiKey, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [key] = await db
		.select({ id: apikey.id, key: apikey.key, metadata: apikey.metadata })
		.from(apikey)
		.where(and(eq(apikey.id, id), eq(apikey.organizationId, orgId)))
		.limit(1);

	if (!key) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "API key not found" } },
			404,
		);
	}
	if (
		(key.metadata as Record<string, unknown> | null)?.principal_type ===
		"dashboard_user"
	) {
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

	// Delete from KV using the stored hash
	await c.env.KV.delete(`apikey:${key.key}`);

	// Delete from DB
	await db.delete(apikey).where(eq(apikey.id, id));

	return c.body(null, 204);
});

export default app;
