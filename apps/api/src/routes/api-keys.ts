import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { apikey, createDb, generateId, organizationSubscriptions, workspaces } from "@relayapi/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	ApiKeyCreatedResponse,
	ApiKeyListResponse,
	CreateApiKeyBody,
} from "../schemas/api-keys";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import type { Env, KVKeyData, Variables } from "../types";
import { PRICING } from "../types";
import { hashKey } from "../middleware/auth";
import {
	requireAllWorkspaceScopeMiddleware,
	requireWriteAccessMiddleware,
} from "../middleware/permissions";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requireWriteAccessMiddleware);
app.use("*", requireAllWorkspaceScopeMiddleware);

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
	const { limit } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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
		})
		.from(apikey)
		.where(eq(apikey.organizationId, orgId))
		.orderBy(desc(apikey.createdAt))
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
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(createApiKey, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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
						message: "One or more workspace IDs are invalid or do not belong to this organization.",
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
	const callsIncluded = plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;

	const permissionsArray =
		body.permission === "read_write" ? ["read", "write"] : ["read"];

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
		metadata: { workspace_scope: body.workspace_scope },
	});

	// Write to KV for fast auth lookup
	const kvData: KVKeyData = {
		org_id: orgId,
		key_id: keyId,
		permissions: permissionsArray,
		workspace_scope: body.workspace_scope,
		expires_at: expiresAt?.toISOString() ?? null,
		rate_limit_max: plan === "pro" ? PRICING.proRateLimitMax : PRICING.freeRateLimitMax,
		rate_limit_window: plan === "pro" ? PRICING.proRateLimitWindow : PRICING.freeRateLimitWindow,
		plan,
		calls_included: callsIncluded,
		ai_enabled: c.get("aiEnabled"),
		daily_tool_limit: c.get("dailyToolLimit"),
	};
	await c.env.KV.put(`apikey:${hashedKey}`, JSON.stringify(kvData), {
		expirationTtl: expiresAt
			? Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 60)
			: 86400 * 365,
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
		},
		201,
	);
});

app.openapi(deleteApiKey, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [key] = await db
		.select({ id: apikey.id, key: apikey.key })
		.from(apikey)
		.where(and(eq(apikey.id, id), eq(apikey.organizationId, orgId)))
		.limit(1);

	if (!key) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "API key not found" } },
			404,
		);
	}

	// Delete from KV using the stored hash
	await c.env.KV.delete(`apikey:${key.key}`);

	// Delete from DB
	await db.delete(apikey).where(eq(apikey.id, id));

	return c.body(null, 204);
});

export default app;
