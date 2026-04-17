import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { autoPostRules } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateAutoPostRuleBody,
	UpdateAutoPostRuleBody,
	AutoPostRuleResponse,
	AutoPostRuleListResponse,
	TestFeedBody,
	TestFeedResponse,
} from "../schemas/auto-post-rules";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { parseFeed, validateFeedUrl } from "../services/auto-post-processor";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helper: serialize a rule row to the API response shape
// ---------------------------------------------------------------------------

function serializeRule(rule: typeof autoPostRules.$inferSelect) {
	return {
		id: rule.id,
		name: rule.name,
		feed_url: rule.feedUrl,
		polling_interval_minutes: rule.pollingIntervalMinutes,
		content_template: rule.contentTemplate,
		append_feed_url: rule.appendFeedUrl,
		account_ids: rule.accountIds ?? [],
		status: rule.status,
		consecutive_errors: rule.consecutiveErrors,
		last_processed_url: rule.lastProcessedUrl,
		last_processed_at: rule.lastProcessedAt?.toISOString() ?? null,
		last_error: rule.lastError,
		workspace_id: rule.workspaceId,
		created_at: rule.createdAt.toISOString(),
		updated_at: rule.updatedAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createRuleRoute = createRoute({
	operationId: "createAutoPostRule",
	method: "post",
	path: "/",
	tags: ["Auto-Post"],
	summary: "Create an auto-post rule",
	description:
		"Create a new auto-post rule to automatically post from an RSS/Atom feed.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateAutoPostRuleBody } },
		},
	},
	responses: {
		201: {
			description: "Rule created",
			content: {
				"application/json": { schema: AutoPostRuleResponse },
			},
		},
		400: {
			description: "Invalid feed URL",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const AutoPostListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	status: z
		.enum(["active", "paused", "error"])
		.optional()
		.describe("Filter by status"),
});

const listRulesRoute = createRoute({
	operationId: "listAutoPostRules",
	method: "get",
	path: "/",
	tags: ["Auto-Post"],
	summary: "List auto-post rules",
	security: [{ Bearer: [] }],
	request: { query: AutoPostListQuery },
	responses: {
		200: {
			description: "List of rules",
			content: {
				"application/json": { schema: AutoPostRuleListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getRuleRoute = createRoute({
	operationId: "getAutoPostRule",
	method: "get",
	path: "/{id}",
	tags: ["Auto-Post"],
	summary: "Get an auto-post rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Rule details",
			content: {
				"application/json": { schema: AutoPostRuleResponse },
			},
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

const updateRuleRoute = createRoute({
	operationId: "updateAutoPostRule",
	method: "patch",
	path: "/{id}",
	tags: ["Auto-Post"],
	summary: "Update an auto-post rule",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: UpdateAutoPostRuleBody },
			},
		},
	},
	responses: {
		200: {
			description: "Rule updated",
			content: {
				"application/json": { schema: AutoPostRuleResponse },
			},
		},
		400: {
			description: "Invalid feed URL",
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

const deleteRuleRoute = createRoute({
	operationId: "deleteAutoPostRule",
	method: "delete",
	path: "/{id}",
	tags: ["Auto-Post"],
	summary: "Delete an auto-post rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Rule deleted" },
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

const activateRuleRoute = createRoute({
	operationId: "activateAutoPostRule",
	method: "post",
	path: "/{id}/activate",
	tags: ["Auto-Post"],
	summary: "Activate an auto-post rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Rule activated",
			content: {
				"application/json": { schema: AutoPostRuleResponse },
			},
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

const pauseRuleRoute = createRoute({
	operationId: "pauseAutoPostRule",
	method: "post",
	path: "/{id}/pause",
	tags: ["Auto-Post"],
	summary: "Pause an auto-post rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Rule paused",
			content: {
				"application/json": { schema: AutoPostRuleResponse },
			},
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

const testFeedRoute = createRoute({
	operationId: "testFeed",
	method: "post",
	path: "/test-feed",
	tags: ["Auto-Post"],
	summary: "Test-parse a feed URL",
	description: "Parse a feed URL and return the 5 most recent items.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: TestFeedBody } },
		},
	},
	responses: {
		200: {
			description: "Feed items",
			content: { "application/json": { schema: TestFeedResponse } },
		},
		400: {
			description: "Invalid feed",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

app.openapi(createRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");

	// Validate feed URL (SSRF protection)
	try {
		await validateFeedUrl(body.feed_url);
	} catch (err) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message:
						err instanceof Error
							? err.message
							: "Invalid feed URL",
				},
			},
			400,
		);
	}

	const db = c.get("db");

	const [rule] = await db
		.insert(autoPostRules)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			feedUrl: body.feed_url,
			pollingIntervalMinutes: body.polling_interval_minutes,
			contentTemplate: body.content_template ?? null,
			appendFeedUrl: body.append_feed_url,
			accountIds: body.account_ids,
		})
		.returning();

	if (!rule) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create rule",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serializeRule(rule) as never, 201);
});

app.openapi(listRulesRoute, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id, status } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(autoPostRules.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, autoPostRules.workspaceId);
	if (workspace_id) {
		conditions.push(eq(autoPostRules.workspaceId, workspace_id));
	}
	if (status) {
		conditions.push(eq(autoPostRules.status, status));
	}
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: autoPostRules.createdAt })
			.from(autoPostRules)
			.where(eq(autoPostRules.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${autoPostRules.createdAt} < ${cursorRow.createdAt} OR (${autoPostRules.createdAt} = ${cursorRow.createdAt} AND ${autoPostRules.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(autoPostRules)
		.where(and(...conditions))
		.orderBy(desc(autoPostRules.createdAt), desc(autoPostRules.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor = hasMore && lastRow ? lastRow.id : null;

	return c.json(
		{
			data: data.map(serializeRule),
			next_cursor: nextCursor,
			has_more: hasMore,
		} as never,
		200,
	);
});

app.openapi(getRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [rule] = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.id, id),
				eq(autoPostRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!rule) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	return c.json(serializeRule(rule) as never, 200);
});

app.openapi(updateRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.id, id),
				eq(autoPostRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	// Validate new feed URL if provided
	if (body.feed_url) {
		try {
			await validateFeedUrl(body.feed_url);
		} catch (err) {
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message:
							err instanceof Error
								? err.message
								: "Invalid feed URL",
					},
				},
				400,
			);
		}
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.feed_url !== undefined) updates.feedUrl = body.feed_url;
	if (body.polling_interval_minutes !== undefined)
		updates.pollingIntervalMinutes = body.polling_interval_minutes;
	if (body.content_template !== undefined)
		updates.contentTemplate = body.content_template;
	if (body.append_feed_url !== undefined)
		updates.appendFeedUrl = body.append_feed_url;
	if (body.account_ids !== undefined) updates.accountIds = body.account_ids;

	const [updated] = await db
		.update(autoPostRules)
		.set(updates)
		.where(eq(autoPostRules.id, id))
		.returning();

	const rule = updated ?? existing;

	return c.json(serializeRule(rule) as never, 200);
});

app.openapi(deleteRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({
			id: autoPostRules.id,
			workspaceId: autoPostRules.workspaceId,
		})
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.id, id),
				eq(autoPostRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(autoPostRules).where(eq(autoPostRules.id, id));

	return c.body(null, 204);
});

app.openapi(activateRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.id, id),
				eq(autoPostRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const [updated] = await db
		.update(autoPostRules)
		.set({
			status: "active",
			consecutiveErrors: 0,
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(autoPostRules.id, id))
		.returning();

	return c.json(serializeRule(updated ?? existing) as never, 200);
});

app.openapi(pauseRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.id, id),
				eq(autoPostRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const [updated] = await db
		.update(autoPostRules)
		.set({ status: "paused", updatedAt: new Date() })
		.where(eq(autoPostRules.id, id))
		.returning();

	return c.json(serializeRule(updated ?? existing) as never, 200);
});

app.openapi(testFeedRoute, async (c) => {
	const body = c.req.valid("json");

	try {
		await validateFeedUrl(body.feed_url);
	} catch (err) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message:
						err instanceof Error
							? err.message
							: "Invalid feed URL",
				},
			},
			400,
		);
	}

	try {
		const items = await parseFeed(body.feed_url);
		return c.json(
			{
				items: items.slice(0, 5).map((item) => ({
					title: item.title,
					url: item.url,
					description: item.description.slice(0, 500),
					published_at: item.publishedAt?.toISOString() ?? null,
					image_url: item.imageUrl,
				})),
			} as never,
			200,
		);
	} catch (err) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message:
						err instanceof Error
							? err.message
							: "Failed to parse feed",
				},
			},
			400,
		);
	}
});

export default app;
