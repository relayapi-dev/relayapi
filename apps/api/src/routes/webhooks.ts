import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	generateId,
	webhookEndpoints,
	webhookEvents,
	webhookLogs,
} from "@relayapi/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { activeEncryptionKeyId, maybeEncrypt } from "../lib/crypto";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import { resolveOperationalCreateScope } from "../lib/request-access";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
	workspaceScopeSqlCondition,
} from "../lib/workspace-scope";
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
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function generateWebhookSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `whsec_${hex}`;
}

export function webhookLogWorkspaceAccessCondition(workspaceScope: string[]) {
	return and(
		workspaceScopeSqlCondition(workspaceScope, webhookEndpoints.workspaceId),
		workspaceScopeSqlCondition(workspaceScope, webhookEvents.workspaceId),
	);
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

const rotateWebhookSecretRoute = createRoute({
	operationId: "rotateWebhookSecret",
	method: "post",
	path: "/{id}/rotate-secret",
	tags: ["Webhooks"],
	summary: "Rotate a webhook signing secret",
	description:
		"Atomically replaces the signing secret. The new secret is returned once.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Webhook signing secret rotated",
			content: { "application/json": { schema: WebhookCreatedResponse } },
		},
		403: {
			description: "Workspace access denied",
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

// --- Route handlers ---

app.openapi(listWebhooks, async (c) => {
	const orgId = c.get("orgId");
	const { limit, workspace_id, cursor } = c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: ReturnType<typeof decodeTimestampIdCursor> | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const conditions = [eq(webhookEndpoints.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, webhookEndpoints.workspaceId);
	if (workspace_id) {
		conditions.push(eq(webhookEndpoints.workspaceId, workspace_id));
	}
	if (decodedCursor) {
		conditions.push(
			sql`(${webhookEndpoints.createdAt}, ${webhookEndpoints.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const rows = await db
		.select({
			id: webhookEndpoints.id,
			url: webhookEndpoints.url,
			enabled: webhookEndpoints.enabled,
			events: webhookEndpoints.events,
			createdAt: webhookEndpoints.createdAt,
			updatedAt: webhookEndpoints.updatedAt,
			cursorTimestamp: sql<string>`to_char(${webhookEndpoints.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(webhookEndpoints)
		.where(and(...conditions))
		.orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
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

app.openapi(createWebhookRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"webhook",
	);
	if (!scope.ok) return scope.response as never;

	// SECURITY: Block private/internal URLs
	if (await isBlockedUrlWithDns(body.url)) {
		return c.json(
			{
				error: {
					code: "INVALID_URL",
					message: "Webhook URL targets a blocked address",
				},
			},
			400,
		);
	}

	const rawSecret = generateWebhookSecret();
	const webhookId = generateId("wh_");
	const encryptedSecret = await maybeEncrypt(rawSecret, c.env.ENCRYPTION_KEY, {
		recordId: webhookId,
		field: "secret_ciphertext",
	});
	if (!encryptedSecret)
		throw new Error("Webhook secret encryption returned empty");

	const [webhook] = await db
		.insert(webhookEndpoints)
		.values({
			id: webhookId,
			organizationId: orgId,
			workspaceId: scope.workspaceId,
			url: body.url,
			secretCiphertext: encryptedSecret,
			secretKeyId: activeEncryptionKeyId(c.env.ENCRYPTION_KEY),
			events: body.events,
		})
		.returning();
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

app.openapi(rotateWebhookSecretRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
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
	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const rawSecret = generateWebhookSecret();
	const secretCiphertext = await maybeEncrypt(rawSecret, c.env.ENCRYPTION_KEY, {
		recordId: id,
		field: "secret_ciphertext",
	});
	if (!secretCiphertext)
		throw new Error("Webhook secret encryption returned empty");
	const [updated] = await db
		.update(webhookEndpoints)
		.set({
			secretCiphertext,
			secretKeyId: activeEncryptionKeyId(c.env.ENCRYPTION_KEY),
			enabled: true,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(webhookEndpoints.id, id),
				eq(webhookEndpoints.organizationId, orgId),
			),
		)
		.returning();
	if (!updated) throw new Error("Webhook secret rotation failed");
	return c.json(
		{
			id: updated.id,
			url: updated.url,
			secret: rawSecret,
			enabled: updated.enabled,
			events: updated.events ?? [],
			created_at: updated.createdAt.toISOString(),
		},
		200,
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
	if (body.url !== undefined && (await isBlockedUrlWithDns(body.url))) {
		return c.json(
			{
				error: {
					code: "INVALID_URL",
					message: "Webhook URL targets a blocked address",
				},
			} as never,
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
		.select({
			id: webhookEndpoints.id,
			workspaceId: webhookEndpoints.workspaceId,
		})
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
			{
				error: {
					code: "INVALID_URL",
					message: "Webhook URL targets a blocked address",
				},
			},
			400,
		);
	}

	const start = Date.now();
	let statusCode: number | null = null;
	let success = false;

	try {
		const response = await fetchWithTimeout(webhook.url, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "webhook.test",
				data: { test: true },
				timestamp: new Date().toISOString(),
			}),
			timeout: 5_000,
		});
		statusCode = response.status;
		success = response.ok;
		await response.body?.cancel().catch(() => {});
	} catch {
		success = false;
	}

	const responseTimeMs = Date.now() - start;

	// Store the test occurrence once and keep only attempt-specific data in the
	// log row, matching the normal delivery path.
	try {
		const webhookEventId = generateId("whe_");
		await db.transaction(async (tx) => {
			await tx.insert(webhookEvents).values({
				id: webhookEventId,
				occurrenceId: webhookEventId,
				organizationId: orgId,
				workspaceId: webhook.workspaceId,
				event: "webhook.test",
				payload: { test: true },
			});
			await tx.insert(webhookLogs).values({
				webhookId: webhook.id,
				webhookEventId,
				organizationId: orgId,
				statusCode,
				responseTimeMs,
				success,
				error: success ? null : `HTTP ${statusCode ?? "connection failed"}`,
			});
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
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");
	const workspaceScope = c.get("workspaceScope");
	let decodedCursor: ReturnType<typeof decodeTimestampIdCursor> | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

	const logConditions = [
		eq(webhookLogs.organizationId, orgId),
		gte(webhookLogs.createdAt, sevenDaysAgo),
	];
	if (decodedCursor) {
		logConditions.push(
			sql`(${webhookLogs.createdAt}, ${webhookLogs.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const rows =
		workspaceScope === "all"
			? await db
					.select({
						id: webhookLogs.id,
						webhookId: webhookLogs.webhookId,
						event: webhookEvents.event,
						statusCode: webhookLogs.statusCode,
						responseTimeMs: webhookLogs.responseTimeMs,
						success: webhookLogs.success,
						error: webhookLogs.error,
						payload: webhookEvents.payload,
						createdAt: webhookLogs.createdAt,
						cursorTimestamp: sql<string>`to_char(${webhookLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
					})
					.from(webhookLogs)
					.innerJoin(
						webhookEvents,
						and(
							eq(webhookLogs.webhookEventId, webhookEvents.id),
							eq(webhookLogs.organizationId, webhookEvents.organizationId),
						),
					)
					.where(and(...logConditions))
					.orderBy(desc(webhookLogs.createdAt), desc(webhookLogs.id))
					.limit(limit + 1)
			: await db
					.select({
						id: webhookLogs.id,
						webhookId: webhookLogs.webhookId,
						event: webhookEvents.event,
						statusCode: webhookLogs.statusCode,
						responseTimeMs: webhookLogs.responseTimeMs,
						success: webhookLogs.success,
						error: webhookLogs.error,
						payload: webhookEvents.payload,
						createdAt: webhookLogs.createdAt,
						cursorTimestamp: sql<string>`to_char(${webhookLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
					})
					.from(webhookLogs)
					.innerJoin(
						webhookEvents,
						and(
							eq(webhookLogs.webhookEventId, webhookEvents.id),
							eq(webhookLogs.organizationId, webhookEvents.organizationId),
						),
					)
					.innerJoin(
						webhookEndpoints,
						eq(webhookLogs.webhookId, webhookEndpoints.id),
					)
					.where(
						and(
							...logConditions,
							webhookLogWorkspaceAccessCondition(workspaceScope),
						),
					)
					.orderBy(desc(webhookLogs.createdAt), desc(webhookLogs.id))
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

export default app;
