import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	createDb,
	generateId,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import {
	CreateThreadBody,
	ThreadIdParam,
	ThreadListQuery,
	ThreadListResponse,
	ThreadResponse,
	UpdateThreadBody,
} from "../schemas/threads";
import { resolveTargets } from "../services/target-resolver";
import { isThreadable } from "../services/thread-publisher";
import { assertScopedCreateWorkspace } from "../lib/request-access";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import type { Env, Variables } from "../types";
import type { MediaAttachment } from "../publishers/types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Route definitions ---

const createThread = createRoute({
	operationId: "createThread",
	method: "post",
	path: "/",
	tags: ["Threads"],
	summary: "Create a thread",
	description: "Create a multi-item thread for publishing as a reply chain on supported platforms.",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateThreadBody } } },
	},
	responses: {
		201: {
			description: "Thread created",
			content: { "application/json": { schema: ThreadResponse } },
		},
		400: { description: "Bad request", content: { "application/json": { schema: ErrorResponse } } },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		409: { description: "Conflict", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const getThread = createRoute({
	operationId: "getThread",
	method: "get",
	path: "/{thread_group_id}",
	tags: ["Threads"],
	summary: "Get a thread",
	description: "Retrieve a full thread with all items and their per-target results.",
	security: [{ Bearer: [] }],
	request: { params: ThreadIdParam },
	responses: {
		200: {
			description: "Thread details",
			content: { "application/json": { schema: ThreadResponse } },
		},
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const listThreads = createRoute({
	operationId: "listThreads",
	method: "get",
	path: "/",
	tags: ["Threads"],
	summary: "List threads",
	security: [{ Bearer: [] }],
	request: { query: ThreadListQuery },
	responses: {
		200: {
			description: "Threads list",
			content: { "application/json": { schema: ThreadListResponse } },
		},
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const deleteThread = createRoute({
	operationId: "deleteThread",
	method: "delete",
	path: "/{thread_group_id}",
	tags: ["Threads"],
	summary: "Delete a thread",
	description: "Delete an entire thread and all its items.",
	security: [{ Bearer: [] }],
	request: { params: ThreadIdParam },
	responses: {
		204: { description: "Thread deleted" },
		401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponse } } },
		404: { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// --- Helper: build thread response ---

async function buildThreadResponse(
	db: ReturnType<typeof createDb>,
	orgId: string,
	threadGroupId: string,
): Promise<Record<string, unknown> | null> {
	const threadPosts = await db
		.select({
			id: posts.id,
			content: posts.content,
			status: posts.status,
			threadPosition: posts.threadPosition,
			threadDelayMs: posts.threadDelayMs,
			platformOverrides: posts.platformOverrides,
			scheduledAt: posts.scheduledAt,
			timezone: posts.timezone,
			createdAt: posts.createdAt,
			updatedAt: posts.updatedAt,
		})
		.from(posts)
		.where(
			and(
				eq(posts.threadGroupId, threadGroupId),
				eq(posts.organizationId, orgId),
			),
		)
		.orderBy(asc(posts.threadPosition));

	if (threadPosts.length === 0) return null;

	const postIds = threadPosts.map((p) => p.id);
	const targets = await db
		.select({
			id: postTargets.id,
			postId: postTargets.postId,
			socialAccountId: postTargets.socialAccountId,
			platform: postTargets.platform,
			status: postTargets.status,
			platformPostId: postTargets.platformPostId,
			platformUrl: postTargets.platformUrl,
			error: postTargets.error,
		})
		.from(postTargets)
		.where(inArray(postTargets.postId, postIds));

	const targetsByPost = new Map<string, typeof targets>();
	for (const t of targets) {
		const list = targetsByPost.get(t.postId) ?? [];
		list.push(t);
		targetsByPost.set(t.postId, list);
	}

	const items = threadPosts.map((p) => {
		const postTargetsList = targetsByPost.get(p.id) ?? [];
		const overrides = (p.platformOverrides ?? {}) as Record<string, unknown>;
		const media = (overrides._media as MediaAttachment[]) ?? null;

		const targetsObj: Record<string, unknown> = {};
		for (const t of postTargetsList) {
			targetsObj[t.socialAccountId] = {
				platform: t.platform,
				status: t.status,
				platform_post_id: t.platformPostId ?? null,
				platform_url: t.platformUrl ?? null,
				error: t.error ?? null,
			};
		}

		return {
			id: p.id,
			position: p.threadPosition ?? 0,
			content: p.content,
			media,
			delay_minutes: Math.round((p.threadDelayMs ?? 0) / 60000),
			status: p.status,
			targets: targetsObj,
		};
	});

	// Compute overall thread status
	const statuses = threadPosts.map((p) => p.status);
	let threadStatus: string;
	if (statuses.every((s) => s === "published")) threadStatus = "published";
	else if (statuses.every((s) => s === "failed")) threadStatus = "failed";
	else if (statuses.every((s) => s === "draft")) threadStatus = "draft";
	else if (statuses.every((s) => s === "scheduled")) threadStatus = "scheduled";
	else if (statuses.some((s) => s === "publishing")) threadStatus = "publishing";
	else threadStatus = "partial";

	const root = threadPosts[0]!;
	return {
		thread_group_id: threadGroupId,
		status: threadStatus,
		items,
		scheduled_at: root.scheduledAt?.toISOString() ?? null,
		timezone: root.timezone,
		created_at: root.createdAt.toISOString(),
		updated_at: root.updatedAt.toISOString(),
	};
}

// --- Handlers ---

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(createThread, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "thread");
	if (denied) return denied;

	// Resolve targets
	const { resolved, failed } = await resolveTargets(db, orgId, body.targets, c.get("workspaceScope"));
	if (resolved.length === 0) {
		return c.json(
			{
				error: {
					code: "NO_VALID_TARGETS",
					message: failed.length > 0
						? failed.map((f) => `${f.key}: ${f.error.message}`).join("; ")
						: "No valid targets resolved.",
				},
			},
			400 as any,
		);
	}

	// Determine scheduling
	const isDraft = body.scheduled_at === "draft";
	const isNow = body.scheduled_at === "now";
	const isAuto = body.scheduled_at === "auto";

	let scheduledAt: Date | null;
	if (isDraft) {
		scheduledAt = null;
	} else if (isNow) {
		scheduledAt = new Date();
	} else if (isAuto) {
		const { findBestSlot } = await import("../services/slot-finder");
		const slot = await findBestSlot(c.env, orgId, {
			accountId: resolved[0]?.accounts[0]?.id,
			after: new Date(),
			strategy: "smart",
		});
		if (!slot) {
			return c.json(
				{
					error: {
						code: "NO_SLOT_AVAILABLE",
						message: "No available slot found.",
					},
				},
				409 as any,
			);
		}
		scheduledAt = new Date(slot.slot_at);
	} else {
		scheduledAt = new Date(body.scheduled_at);
	}

	const threadGroupId = generateId("thg_");
	const postStatus = isDraft ? "draft" : isNow ? "publishing" : "scheduled";

	// Flatten all accounts from resolved targets
	const allAccounts = resolved.flatMap((r) => r.accounts.map((a) => ({ ...a, platform: r.platform })));
	const uniqueAccounts = [...new Map(allAccounts.map((a) => [a.id, a])).values()];

	// Create post rows for each thread item
	const createdPostIds: string[] = [];
	for (let i = 0; i < body.items.length; i++) {
		const item = body.items[i]!;
		const postId = generateId("post_");

		const platformOverrides: Record<string, unknown> = {
			...(body.target_options ?? {}),
			...(item.media && item.media.length > 0 ? { _media: item.media } : {}),
		};

		await db.insert(posts).values({
			id: postId,
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			content: item.content,
			status: postStatus as any,
			scheduledAt,
			timezone: body.timezone,
			platformOverrides,
			threadGroupId,
			threadPosition: i,
			threadDelayMs: (item.delay_minutes ?? 0) * 60000,
		});

		// Create post targets for each account
		for (const account of uniqueAccounts) {
			await db.insert(postTargets).values({
				id: generateId(""),
				postId,
				socialAccountId: account.id,
				platform: account.platform as any,
				status: postStatus as any,
			});
		}

		createdPostIds.push(postId);
	}

	// Enqueue for publishing if immediate
	if (isNow) {
		await c.env.PUBLISH_QUEUE.send({
			type: "publish_thread",
			thread_group_id: threadGroupId,
			org_id: orgId,
			position: 0,
		});
	}

	// Build response
	const response = await buildThreadResponse(db, orgId, threadGroupId);
	return c.json(response, 201);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getThread, async (c) => {
	const orgId = c.get("orgId");
	const { thread_group_id } = c.req.valid("param");
	const db = c.get("db");
	const [existing] = await db
		.select({ workspaceId: posts.workspaceId })
		.from(posts)
		.where(
			and(
				eq(posts.threadGroupId, thread_group_id),
				eq(posts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Thread not found" } },
			404 as any,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const response = await buildThreadResponse(db, orgId, thread_group_id);
	if (!response) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Thread not found" } },
			404 as any,
		);
	}

	return c.json(response, 200);
});

app.openapi(listThreads, async (c) => {
	const orgId = c.get("orgId");
	const { cursor, limit, workspace_id, status } = c.req.valid("query");
	const db = c.get("db");

	// Find all thread group IDs (distinct) from root posts (position 0)
	const conditions = [
		eq(posts.organizationId, orgId),
		eq(posts.threadPosition, 0),
		isNotNull(posts.threadGroupId),
	];
	applyWorkspaceScope(c, conditions, posts.workspaceId);
	if (workspace_id) conditions.push(eq(posts.workspaceId, workspace_id));
	if (status) conditions.push(eq(posts.status, status as any));
	if (cursor) conditions.push(sql`${posts.createdAt} < ${new Date(cursor)}`);

	const rootPosts = await db
		.select({
			threadGroupId: posts.threadGroupId,
			content: posts.content,
			status: posts.status,
			scheduledAt: posts.scheduledAt,
			createdAt: posts.createdAt,
			updatedAt: posts.updatedAt,
		})
		.from(posts)
		.where(and(...conditions))
		.orderBy(desc(posts.createdAt))
		.limit(limit + 1);

	const hasMore = rootPosts.length > limit;
	const page = rootPosts.slice(0, limit);

	// Count items per thread group
	const groupIds = page.map((p) => p.threadGroupId).filter(Boolean) as string[];
	let itemCounts = new Map<string, number>();
	if (groupIds.length > 0) {
		const counts = await db
			.select({
				threadGroupId: posts.threadGroupId,
				count: sql<number>`count(*)::int`,
			})
			.from(posts)
			.where(inArray(posts.threadGroupId, groupIds))
			.groupBy(posts.threadGroupId);
		itemCounts = new Map(counts.map((c) => [c.threadGroupId!, c.count]));
	}

	const data = page.map((p) => ({
		thread_group_id: p.threadGroupId!,
		status: p.status,
		item_count: itemCounts.get(p.threadGroupId!) ?? 1,
		root_content: p.content,
		scheduled_at: p.scheduledAt?.toISOString() ?? null,
		created_at: p.createdAt.toISOString(),
		updated_at: p.updatedAt.toISOString(),
	}));

	const nextCursor = hasMore && page.length > 0
		? page[page.length - 1]!.createdAt.toISOString()
		: null;

	return c.json({ data, next_cursor: nextCursor, has_more: hasMore }, 200);
});

app.openapi(deleteThread, async (c) => {
	const orgId = c.get("orgId");
	const { thread_group_id } = c.req.valid("param");
	const db = c.get("db");

	// Verify thread exists and belongs to org
	const [existing] = await db
		.select({ id: posts.id, workspaceId: posts.workspaceId })
		.from(posts)
		.where(
			and(
				eq(posts.threadGroupId, thread_group_id),
				eq(posts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Thread not found" } },
			404 as any,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	// Get all post IDs in the thread
	const threadPostIds = await db
		.select({ id: posts.id })
		.from(posts)
		.where(eq(posts.threadGroupId, thread_group_id));

	const ids = threadPostIds.map((p) => p.id);

	// Delete targets first (foreign key), then posts
	if (ids.length > 0) {
		await db.delete(postTargets).where(inArray(postTargets.postId, ids));
		await db.delete(posts).where(inArray(posts.id, ids));
	}

	return c.body(null, 204);
});

export default app;
