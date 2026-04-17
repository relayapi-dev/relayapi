import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { webhookEndpoints, webhookLogs } from "@relayapi/db";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateWebhookBody,
	TestWebhookBody,
	TestWebhookResponse,
	UpdateWebhookBody,
	WebhookCreatedResponse,
	WebhookListResponse,
	WebhookResponse,
} from "../schemas/webhooks";
import { deliverWebhook } from "../services/webhook-delivery";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { maybeEncrypt } from "../lib/crypto";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

async function hashSecret(raw: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(raw);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function generateWebhookSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `whsec_${hex}`;
}

// --- Route definitions ---

const WebhookListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
});

const listWebhooks = createRoute({
	operationId: "listWebhooks",
	method: "get",
	path: "/",
	tags: ["Webhooks"],
	summary: "List webhook endpoints",
	security: [{ Bearer: [] }],
	request: { query: WebhookListQuery },
	responses: {
		200: {
			description: "List of webhooks",
			content: { "application/json": { schema: WebhookListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createWebhookRoute = createRoute({
	operationId: "createWebhook",
	method: "post",
	path: "/",
	tags: ["Webhooks"],
	summary: "Create a webhook endpoint",
	description:
		"Create a new webhook endpoint. The signing secret is returned only once in the response.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateWebhookBody } },
		},
	},
	responses: {
		201: {
			description: "Webhook created",
			content: {
				"application/json": { schema: WebhookCreatedResponse },
			},
		},
		400: {
			description: "Invalid URL",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateWebhookRoute = createRoute({
	operationId: "updateWebhook",
	method: "patch",
	path: "/{id}",
	tags: ["Webhooks"],
	summary: "Update a webhook endpoint",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateWebhookBody } },
		},
	},
	responses: {
		200: {
			description: "Webhook updated",
			content: { "application/json": { schema: WebhookResponse } },
		},
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

const deleteWebhook = createRoute({
	operationId: "deleteWebhook",
	method: "delete",
	path: "/{id}",
	tags: ["Webhooks"],
	summary: "Delete a webhook endpoint",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Webhook deleted" },
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

const testWebhookRoute = createRoute({
	operationId: "testWebhook",
	method: "post",
	path: "/test",
	tags: ["Webhooks"],
	summary: "Send a test webhook delivery",
	description:
		"Send a test POST request to the webhook URL to verify it is reachable.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: TestWebhookBody } },
		},
	},
	responses: {
		200: {
			description: "Test delivery result",
			content: { "application/json": { schema: TestWebhookResponse } },
		},
		400: {
			description: "Invalid URL",
			content: { "application/json": { schema: ErrorResponse } },
		},
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

const WebhookLogEntry = z.object({
	id: z.string(),
	webhook_id: z.string(),
	event: z.string(),
	status_code: z.number().nullable(),
	response_time_ms: z.number().nullable(),
	success: z.boolean(),
	error: z.string().nullable(),
	created_at: z.string().datetime(),
});

const WebhookLogListResponse = z.object({
	data: z.array(WebhookLogEntry),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

const getWebhookLogs = createRoute({
	operationId: "getWebhookLogs",
	method: "get",
	path: "/logs",
	tags: ["Webhooks"],
	summary: "List webhook delivery logs",
	description: "Returns delivery logs from the last 7 days.",
	security: [{ Bearer: [] }],
	request: { query: PaginationParams },
	responses: {
		200: {
			description: "Delivery logs",
			content: {
				"application/json": {
					schema: WebhookLogListResponse,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

app.openapi(listWebhooks, async (c) => {
	const orgId = c.get("orgId");
	const { limit, workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(webhookEndpoints.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, webhookEndpoints.workspaceId);
	if (workspace_id) {
		conditions.push(eq(webhookEndpoints.workspaceId, workspace_id));
	}

	const rows = await db
		.select({
			id: webhookEndpoints.id,
			url: webhookEndpoints.url,
			enabled: webhookEndpoints.enabled,
			events: webhookEndpoints.events,
			createdAt: webhookEndpoints.createdAt,
			updatedAt: webhookEndpoints.updatedAt,
		})
		.from(webhookEndpoints)
		.where(and(...conditions))
		.orderBy(desc(webhookEndpoints.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((w) => ({
				id: w.id,
				url: w.url,
				enabled: w.enabled,
				events: w.events ?? [],
				created_at: w.createdAt.toISOString(),
				updated_at: w.updatedAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — handler may return 400/403 from scoped workspace and URL validation
app.openapi(createWebhookRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const scopeDenied = assertScopedCreateWorkspace(c, body.workspace_id, "webhook");
	if (scopeDenied) return scopeDenied;

	// SECURITY: Block private/internal URLs
	if (await isBlockedUrlWithDns(body.url)) {
		return c.json(
			{ error: { code: "INVALID_URL", message: "Webhook URL targets a blocked address" } },
			400,
		);
	}

	const rawSecret = generateWebhookSecret();
	const hashedSecret = await hashSecret(rawSecret);

	const rows = await db
		.insert(webhookEndpoints)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			url: body.url,
			secret: hashedSecret,
			events: body.events,
		})
		.returning();

	const webhook = rows[0];
	if (!webhook) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create webhook",
				},
			} as never,
			500 as never,
		);
	}

	// Store raw secret in KV for HMAC signing (DB only has the hash)
	// TTL of 1 year — cleaned up on webhook deletion, TTL prevents orphans
	const encryptedSecret = await maybeEncrypt(rawSecret, c.env.ENCRYPTION_KEY);
	await c.env.KV.put(`webhook-secret:${webhook.id}`, encryptedSecret ?? rawSecret, {
		expirationTtl: 86400 * 365,
	});

	return c.json(
		{
			id: webhook.id,
			url: webhook.url,
			secret: rawSecret,
			enabled: webhook.enabled,
			events: webhook.events ?? [],
			created_at: webhook.createdAt.toISOString(),
		},
		201,
	);
});

// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(updateWebhookRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(webhookEndpoints)
		.where(
			and(
				eq(webhookEndpoints.id, id),
				eq(webhookEndpoints.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Webhook not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	// SECURITY: Block private/internal URLs on update
	if (body.url !== undefined && await isBlockedUrlWithDns(body.url)) {
		return c.json(
			{ error: { code: "INVALID_URL", message: "Webhook URL targets a blocked address" } } as never,
			400 as never,
		);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.url !== undefined) updates.url = body.url;
	if (body.events !== undefined) updates.events = body.events;
	if (body.enabled !== undefined) updates.enabled = body.enabled;

	const updatedRows = await db
		.update(webhookEndpoints)
		.set(updates)
		.where(eq(webhookEndpoints.id, id))
		.returning();

	const w = updatedRows[0] ?? existing;

	return c.json(
		{
			id: w.id,
			url: w.url,
			enabled: w.enabled,
			events: w.events ?? [],
			created_at: w.createdAt.toISOString(),
			updated_at: w.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(deleteWebhook, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: webhookEndpoints.id, workspaceId: webhookEndpoints.workspaceId })
		.from(webhookEndpoints)
		.where(
			and(
				eq(webhookEndpoints.id, id),
				eq(webhookEndpoints.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Webhook not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
	// Clean up raw secret from KV
	await c.env.KV.delete(`webhook-secret:${id}`);

	return c.body(null, 204);
});

// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(testWebhookRoute, async (c) => {
	const orgId = c.get("orgId");
	const { webhook_id } = c.req.valid("json");
	const db = c.get("db");

	const [webhook] = await db
		.select()
		.from(webhookEndpoints)
		.where(
			and(
				eq(webhookEndpoints.id, webhook_id),
				eq(webhookEndpoints.organizationId, orgId),
			),
		)
		.limit(1);

	if (!webhook) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Webhook not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, webhook.workspaceId);
	if (denied) return denied;

	// SECURITY: Block requests to private/internal URLs
	if (await isBlockedUrlWithDns(webhook.url)) {
		return c.json(
			{ error: { code: "INVALID_URL", message: "Webhook URL targets a blocked address" } },
			400,
		);
	}

	const start = Date.now();
	let statusCode: number | null = null;
	let success = false;

	try {
		const response = await fetch(webhook.url, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "webhook.test",
				data: { test: true },
				timestamp: new Date().toISOString(),
			}),
		});
		statusCode = response.status;
		success = response.ok;
	} catch {
		success = false;
	}

	const responseTimeMs = Date.now() - start;

	// Log the test delivery
	try {
		await db.insert(webhookLogs).values({
			webhookId: webhook.id,
			organizationId: orgId,
			event: "webhook.test",
			payload: { test: true } as Record<string, unknown>,
			statusCode,
			responseTimeMs,
			success,
			error: success ? null : `HTTP ${statusCode ?? "connection failed"}`,
		});
	} catch {
		// Non-critical: log failure is ok
	}

	return c.json(
		{
			success,
			status_code: statusCode,
			response_time_ms: responseTimeMs,
		},
		200,
	);
});

app.openapi(getWebhookLogs, async (c) => {
	const orgId = c.get("orgId");
	const { limit } = c.req.valid("query");
	const db = c.get("db");
	const workspaceScope = c.get("workspaceScope");

	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const rows = workspaceScope === "all"
		? await db
			.select()
			.from(webhookLogs)
			.where(
				and(
					eq(webhookLogs.organizationId, orgId),
					gte(webhookLogs.createdAt, sevenDaysAgo),
				),
			)
			.orderBy(desc(webhookLogs.createdAt))
			.limit(limit + 1)
		: await db
			.select({
				id: webhookLogs.id,
				webhookId: webhookLogs.webhookId,
				event: webhookLogs.event,
				statusCode: webhookLogs.statusCode,
				responseTimeMs: webhookLogs.responseTimeMs,
				success: webhookLogs.success,
				error: webhookLogs.error,
				payload: webhookLogs.payload,
				createdAt: webhookLogs.createdAt,
			})
			.from(webhookLogs)
			.innerJoin(webhookEndpoints, eq(webhookLogs.webhookId, webhookEndpoints.id))
			.where(
				and(
					eq(webhookLogs.organizationId, orgId),
					gte(webhookLogs.createdAt, sevenDaysAgo),
					or(
						inArray(webhookEndpoints.workspaceId, workspaceScope),
						isNull(webhookEndpoints.workspaceId),
					),
				),
			)
			.orderBy(desc(webhookLogs.createdAt))
			.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((l) => ({
				id: l.id,
				webhook_id: l.webhookId,
				event: l.event,
				status_code: l.statusCode,
				response_time_ms: l.responseTimeMs,
				success: l.success,
				error: l.error,
				payload: l.payload,
				created_at: l.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

export default app;
