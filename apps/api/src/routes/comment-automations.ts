import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	commentAutomations,
	commentAutomationLogs,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	CommentAutomationIdParams,
	CommentAutomationListResponse,
	CommentAutomationLogListResponse,
	CommentAutomationResponse,
	CreateCommentAutomationBody,
	UpdateCommentAutomationBody,
} from "../schemas/comment-automations";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serializeAutomation(
	a: typeof commentAutomations.$inferSelect,
) {
	return {
		id: a.id,
		name: a.name,
		platform: a.platform as "instagram" | "facebook",
		account_id: a.socialAccountId,
		post_id: a.postId ?? null,
		enabled: a.enabled,
		keywords: a.keywords,
		match_mode: a.matchMode as "contains" | "exact",
		dm_message: a.dmMessage,
		public_reply: a.publicReply ?? null,
		once_per_user: a.oncePerUser,
		stats: {
			total_triggered: a.totalTriggered,
			last_triggered_at: a.lastTriggeredAt?.toISOString() ?? null,
		},
		created_at: a.createdAt.toISOString(),
	};
}

// --- Route definitions ---

const createAutomation = createRoute({
	operationId: "createCommentAutomation",
	method: "post",
	path: "/",
	tags: ["Comment Automations"],
	summary: "Create a comment-to-DM automation",
	description: "Only one automation allowed per post (or one 'all posts' automation per account). Returns 409 if one already exists. Omit post_id to create an automation that applies to all posts.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: CreateCommentAutomationBody },
			},
		},
	},
	responses: {
		201: {
			description: "Automation created",
			content: {
				"application/json": { schema: CommentAutomationResponse },
			},
		},
		409: {
			description: "Automation already exists for this post",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const CommentAutomationListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

const listAutomations = createRoute({
	operationId: "listCommentAutomations",
	method: "get",
	path: "/",
	tags: ["Comment Automations"],
	summary: "List comment automations",
	security: [{ Bearer: [] }],
	request: { query: CommentAutomationListQuery },
	responses: {
		200: {
			description: "List of automations",
			content: {
				"application/json": { schema: CommentAutomationListResponse },
			},
		},
	},
});

const getAutomation = createRoute({
	operationId: "getCommentAutomation",
	method: "get",
	path: "/{id}",
	tags: ["Comment Automations"],
	summary: "Get automation details",
	security: [{ Bearer: [] }],
	request: { params: CommentAutomationIdParams },
	responses: {
		200: {
			description: "Automation details",
			content: {
				"application/json": { schema: CommentAutomationResponse },
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateAutomation = createRoute({
	operationId: "updateCommentAutomation",
	method: "patch",
	path: "/{id}",
	tags: ["Comment Automations"],
	summary: "Update automation settings",
	security: [{ Bearer: [] }],
	request: {
		params: CommentAutomationIdParams,
		body: {
			content: {
				"application/json": { schema: UpdateCommentAutomationBody },
			},
		},
	},
	responses: {
		200: {
			description: "Updated automation",
			content: {
				"application/json": { schema: CommentAutomationResponse },
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteAutomation = createRoute({
	operationId: "deleteCommentAutomation",
	method: "delete",
	path: "/{id}",
	tags: ["Comment Automations"],
	summary: "Delete automation and all logs",
	security: [{ Bearer: [] }],
	request: { params: CommentAutomationIdParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listLogs = createRoute({
	operationId: "listCommentAutomationLogs",
	method: "get",
	path: "/{id}/logs",
	tags: ["Comment Automations"],
	summary: "List trigger logs for an automation",
	security: [{ Bearer: [] }],
	request: {
		params: CommentAutomationIdParams,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "Trigger logs",
			content: {
				"application/json": { schema: CommentAutomationLogListResponse },
			},
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Handlers ---

// @ts-expect-error — handler returns 201 or 409
app.openapi(createAutomation, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Verify the referenced account is in workspace scope
	const [account] = await db
		.select({ workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(and(eq(socialAccounts.id, body.account_id), eq(socialAccounts.organizationId, orgId)))
		.limit(1);
	if (!account) {
		return c.json({ error: { code: "NOT_FOUND", message: "Account not found" } }, 404);
	}
	const denied = assertWorkspaceScope(c, account.workspaceId);
	if (denied) return denied;

	// Check for duplicate (one automation per post per account, or one "all posts" per account)
	const postCondition = body.post_id
		? eq(commentAutomations.postId, body.post_id)
		: isNull(commentAutomations.postId);

	const [existing] = await db
		.select({ id: commentAutomations.id })
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.socialAccountId, body.account_id),
				postCondition,
			),
		)
		.limit(1);

	if (existing) {
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message: body.post_id
						? "An automation already exists for this post"
						: "An 'all posts' automation already exists for this account",
				},
			},
			409,
		);
	}

	const [created] = await db
		.insert(commentAutomations)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			socialAccountId: body.account_id,
			platform: body.platform,
			postId: body.post_id ?? null,
			name: body.name,
			keywords: body.keywords,
			matchMode: body.match_mode,
			dmMessage: body.dm_message,
			publicReply: body.public_reply ?? null,
			oncePerUser: body.once_per_user,
		})
		.returning();

	if (!created) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create automation" } },
			500,
		);
	}

	return c.json(serializeAutomation(created), 201);
});

app.openapi(listAutomations, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(commentAutomations.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, commentAutomations.workspaceId);
	if (workspace_id) {
		conditions.push(eq(commentAutomations.workspaceId, workspace_id));
	}

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties)
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: commentAutomations.createdAt })
			.from(commentAutomations)
			.where(eq(commentAutomations.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${commentAutomations.createdAt} < ${cursorRow.createdAt} OR (${commentAutomations.createdAt} = ${cursorRow.createdAt} AND ${commentAutomations.id} < ${cursor}))`,
			);
		}
	}

	const automations = await db
		.select()
		.from(commentAutomations)
		.where(and(...conditions))
		.orderBy(desc(commentAutomations.createdAt), desc(commentAutomations.id))
		.limit(limit + 1);

	const hasMore = automations.length > limit;
	const data = automations.slice(0, limit).map(serializeAutomation);

	return c.json(
		{
			data,
			next_cursor: hasMore ? data[data.length - 1]!.id : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getAutomation, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [automation] = await db
		.select()
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!automation) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, automation.workspaceId);
	if (denied) return denied;

	return c.json(serializeAutomation(automation), 200);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(updateAutomation, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Fetch first to verify existence and workspace scope
	const [existing] = await db
		.select()
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const updateSet: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updateSet.name = body.name;
	if (body.keywords !== undefined) updateSet.keywords = body.keywords;
	if (body.match_mode !== undefined) updateSet.matchMode = body.match_mode;
	if (body.dm_message !== undefined) updateSet.dmMessage = body.dm_message;
	if (body.public_reply !== undefined) updateSet.publicReply = body.public_reply;
	if (body.once_per_user !== undefined) updateSet.oncePerUser = body.once_per_user;
	if (body.enabled !== undefined) updateSet.enabled = body.enabled;

	const [updated] = await db
		.update(commentAutomations)
		.set(updateSet)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}

	return c.json(serializeAutomation(updated), 200);
});

app.openapi(deleteAutomation, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Fetch first to verify existence and workspace scope
	const [automation] = await db
		.select()
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!automation) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, automation.workspaceId);
	if (denied) return denied;

	await db
		.delete(commentAutomations)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		);

	return c.body(null, 204);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(listLogs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");

	// Verify automation exists and workspace scope
	const [automation] = await db
		.select({ id: commentAutomations.id, workspaceId: commentAutomations.workspaceId })
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.id, id),
				eq(commentAutomations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!automation) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, automation.workspaceId);
	if (denied) return denied;

	const conditions = [eq(commentAutomationLogs.automationId, id)];
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: commentAutomationLogs.createdAt })
			.from(commentAutomationLogs)
			.where(eq(commentAutomationLogs.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${commentAutomationLogs.createdAt} < ${cursorRow.createdAt} OR (${commentAutomationLogs.createdAt} = ${cursorRow.createdAt} AND ${commentAutomationLogs.id} < ${cursor}))`,
			);
		}
	}

	const logs = await db
		.select()
		.from(commentAutomationLogs)
		.where(and(...conditions))
		.orderBy(desc(commentAutomationLogs.createdAt), desc(commentAutomationLogs.id))
		.limit(limit + 1);

	const hasMore = logs.length > limit;
	const data = logs.slice(0, limit);

	return c.json(
		{
			data: data.map((l) => ({
				id: l.id,
				comment_id: l.commentId,
				commenter_id: l.commenterId,
				commenter_name: l.commenterName ?? null,
				comment_text: l.commentText ?? null,
				dm_sent: l.dmSent,
				reply_sent: l.replySent,
				error: l.error ?? null,
				created_at: l.createdAt.toISOString(),
			})),
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

export default app;
