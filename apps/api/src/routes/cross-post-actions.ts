import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { crossPostActions, posts } from "@relayapi/db";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CrossPostActionListResponse,
	CrossPostActionResponse,
} from "../schemas/cross-post-actions";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serializeAction(a: typeof crossPostActions.$inferSelect) {
	return {
		id: a.id,
		post_id: a.postId,
		action_type: a.actionType as "repost" | "comment" | "quote",
		target_account_id: a.targetAccountId,
		content: a.content ?? null,
		delay_minutes: a.delayMinutes,
		status: a.status,
		scheduled_for: a.scheduledFor.toISOString(),
		next_attempt_at: a.nextAttemptAt.toISOString(),
		executed_at: a.executedAt?.toISOString() ?? null,
		result_post_id: a.resultPostId ?? null,
		error: a.error ?? null,
		created_at: a.createdAt.toISOString(),
	};
}

// --- Route definitions ---

const PostIdParam = z.object({
	post_id: z.string().describe("Post ID"),
});

const listByPost = createRoute({
	operationId: "listCrossPostActions",
	method: "get",
	path: "/posts/{post_id}/cross-post-actions",
	tags: ["Cross-Post Actions"],
	summary: "List cross-post actions for a post",
	security: [{ Bearer: [] }],
	request: {
		params: PostIdParam,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "List of cross-post actions",
			content: { "application/json": { schema: CrossPostActionListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Post not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const cancelAction = createRoute({
	operationId: "cancelCrossPostAction",
	method: "delete",
	path: "/cross-post-actions/{id}",
	tags: ["Cross-Post Actions"],
	summary: "Cancel a pending cross-post action",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Cancelled action",
			content: { "application/json": { schema: CrossPostActionResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Action is not pending",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Handlers ---

app.openapi(listByPost, async (c) => {
	const orgId = c.get("orgId");
	const { post_id } = c.req.valid("param");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	// Verify post belongs to org
	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, post_id), eq(posts.organizationId, orgId)))
		.limit(1);
	if (!post) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Post not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as never;

	const conditions = [eq(crossPostActions.postId, post_id)];

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp
	// ties). Read the cursor row's created_at as raw text so it isn't round-tripped
	// through a JS Date, which truncates Postgres microseconds to millisecond
	// precision and would skip rows sharing the cursor's millisecond. Bind it back
	// with an explicit ::timestamptz cast to keep the keyset comparison exact.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${crossPostActions.createdAt}, ${crossPostActions.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(crossPostActions),
			cursorTimestamp: sql<string>`to_char(${crossPostActions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(crossPostActions)
		.where(and(...conditions))
		.orderBy(desc(crossPostActions.createdAt), desc(crossPostActions.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const pageRows = rows.slice(0, limit);
	const last = pageRows.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;
	const data = pageRows.map(serializeAction);

	return c.json(
		{
			data,
			next_cursor: nextCursor,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(cancelAction, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Find the action and verify ownership through the post
	const [action] = await db
		.select({
			action: crossPostActions,
			postOrgId: posts.organizationId,
			postWorkspaceId: posts.workspaceId,
		})
		.from(crossPostActions)
		.innerJoin(posts, eq(crossPostActions.postId, posts.id))
		.where(eq(crossPostActions.id, id))
		.limit(1);

	if (!action || action.postOrgId !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Cross-post action not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, action.postWorkspaceId);
	if (denied) return denied as never;

	if (!["pending", "retry"].includes(action.action.status)) {
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message: "Only pending or retryable actions can be cancelled",
				},
			},
			409,
		);
	}

	const [updated] = await db
		.update(crossPostActions)
		.set({ status: "cancelled", completedAt: new Date() })
		.where(
			and(
				eq(crossPostActions.id, id),
				inArray(crossPostActions.status, ["pending", "retry"]),
			),
		)
		.returning();

	if (!updated) throw new Error("Failed to update cross-post action");
	return c.json(serializeAction(updated), 200);
});

export default app;
