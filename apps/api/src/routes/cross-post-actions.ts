import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, crossPostActions, posts } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CrossPostActionListResponse,
	CrossPostActionResponse,
} from "../schemas/cross-post-actions";
import type { Env, Variables } from "../types";
import { assertWorkspaceScope } from "../lib/workspace-scope";

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
		status: a.status as "pending" | "executed" | "failed" | "cancelled",
		execute_at: a.executeAt.toISOString(),
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Verify post belongs to org
	const [post] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(and(eq(posts.id, post_id), eq(posts.organizationId, orgId)))
		.limit(1);
	if (!post) {
		return c.json({ error: { code: "NOT_FOUND", message: "Post not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, post.workspaceId);
	if (denied) return denied as any;

	const conditions = [eq(crossPostActions.postId, post_id)];

	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: crossPostActions.createdAt })
			.from(crossPostActions)
			.where(eq(crossPostActions.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${crossPostActions.createdAt} < ${cursorRow.createdAt} OR (${crossPostActions.createdAt} = ${cursorRow.createdAt} AND ${crossPostActions.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(crossPostActions)
		.where(and(...conditions))
		.orderBy(desc(crossPostActions.createdAt), desc(crossPostActions.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeAction);

	return c.json(
		{ data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore },
		200,
	);
});

app.openapi(cancelAction, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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
		return c.json({ error: { code: "NOT_FOUND", message: "Cross-post action not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, action.postWorkspaceId);
	if (denied) return denied as any;

	if (action.action.status !== "pending") {
		return c.json({ error: { code: "CONFLICT", message: "Only pending actions can be cancelled" } }, 409);
	}

	const [updated] = await db
		.update(crossPostActions)
		.set({ status: "cancelled" })
		.where(eq(crossPostActions.id, id))
		.returning();

	return c.json(serializeAction(updated!), 200);
});

export default app;
