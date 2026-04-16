import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	ideas,
	ideaGroups,
	ideaMedia,
	ideaTags,
	ideaComments,
	ideaActivity,
	tags,
	posts,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateIdeaBody,
	UpdateIdeaBody,
	MoveIdeaBody,
	ConvertIdeaBody,
	IdeaResponse,
	IdeaListQuery,
	IdeaListResponse,
	IdeaMediaResponse,
	IdeaActivityResponse,
	IdeaActivityListQuery,
	IdeaActivityListResponse,
	IdeaCommentResponse,
	CreateIdeaCommentBody,
	UpdateIdeaCommentBody,
	IdeaCommentListQuery,
	IdeaCommentListResponse,
} from "../schemas/ideas";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";
import { ensureDefaultGroup } from "./idea-groups";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeTag(row: typeof tags.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
	};
}

function serializeMedia(row: typeof ideaMedia.$inferSelect) {
	return {
		id: row.id,
		url: row.url,
		type: row.type,
		alt: row.alt ?? null,
		position: row.position,
	};
}

function serializeIdea(
	row: typeof ideas.$inferSelect,
	tagRows: (typeof tags.$inferSelect)[],
	mediaRows: (typeof ideaMedia.$inferSelect)[],
) {
	return {
		id: row.id,
		title: row.title ?? null,
		content: row.content ?? null,
		group_id: row.groupId,
		position: row.position,
		assigned_to: row.assignedTo ?? null,
		converted_to_post_id: row.convertedToPostId ?? null,
		tags: tagRows.map(serializeTag),
		media: mediaRows.map(serializeMedia),
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function fetchIdeaTags(
	db: ReturnType<typeof createDb>,
	ideaId: string,
): Promise<(typeof tags.$inferSelect)[]> {
	const rows = await db
		.select({
			id: tags.id,
			name: tags.name,
			color: tags.color,
			organizationId: tags.organizationId,
			workspaceId: tags.workspaceId,
			createdAt: tags.createdAt,
		})
		.from(ideaTags)
		.innerJoin(tags, eq(ideaTags.tagId, tags.id))
		.where(eq(ideaTags.ideaId, ideaId));
	return rows as (typeof tags.$inferSelect)[];
}

async function fetchIdeaMedia(
	db: ReturnType<typeof createDb>,
	ideaId: string,
): Promise<(typeof ideaMedia.$inferSelect)[]> {
	return db
		.select()
		.from(ideaMedia)
		.where(eq(ideaMedia.ideaId, ideaId))
		.orderBy(asc(ideaMedia.position));
}

async function logActivity(
	db: ReturnType<typeof createDb>,
	ideaId: string,
	actorId: string,
	action: (typeof ideaActivity.$inferInsert)["action"],
	metadata?: Record<string, unknown>,
): Promise<void> {
	await db.insert(ideaActivity).values({
		ideaId,
		actorId,
		action,
		metadata: metadata ?? null,
	});
}

// ── List ideas ────────────────────────────────────────────────────────────────

const listIdeas = createRoute({
	operationId: "listIdeas",
	method: "get",
	path: "/",
	tags: ["Ideas"],
	summary: "List ideas",
	security: [{ Bearer: [] }],
	request: { query: IdeaListQuery },
	responses: {
		200: {
			description: "List of ideas",
			content: { "application/json": { schema: IdeaListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listIdeas, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, group_id, tag_id, assigned_to, workspace_id } =
		c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(ideas.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideas.workspaceId);

	if (workspace_id) {
		conditions.push(eq(ideas.workspaceId, workspace_id));
	}
	if (group_id) {
		conditions.push(eq(ideas.groupId, group_id));
	}
	if (assigned_to) {
		conditions.push(eq(ideas.assignedTo, assigned_to));
	}
	if (cursor) {
		conditions.push(lt(ideas.createdAt, new Date(cursor)));
	}

	// When filtering by tag_id, join through idea_tags
	let rows: (typeof ideas.$inferSelect)[];
	if (tag_id) {
		const taggedIdeaIds = await db
			.select({ ideaId: ideaTags.ideaId })
			.from(ideaTags)
			.where(eq(ideaTags.tagId, tag_id));
		const ids = taggedIdeaIds.map((r) => r.ideaId);
		if (ids.length === 0) {
			return c.json({ data: [], next_cursor: null, has_more: false }, 200);
		}
		conditions.push(inArray(ideas.id, ids));
	}

	rows = await db
		.select()
		.from(ideas)
		.where(and(...conditions))
		.orderBy(desc(ideas.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	if (data.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	// Batch-fetch tags and media to avoid N+1
	const ideaIds = data.map((r) => r.id);

	const allTagRows = await db
		.select({
			ideaId: ideaTags.ideaId,
			id: tags.id,
			name: tags.name,
			color: tags.color,
			organizationId: tags.organizationId,
			workspaceId: tags.workspaceId,
			createdAt: tags.createdAt,
		})
		.from(ideaTags)
		.innerJoin(tags, eq(ideaTags.tagId, tags.id))
		.where(inArray(ideaTags.ideaId, ideaIds));

	const allMediaRows = await db
		.select()
		.from(ideaMedia)
		.where(inArray(ideaMedia.ideaId, ideaIds))
		.orderBy(asc(ideaMedia.position));

	// Group by idea ID
	const tagsByIdeaId = new Map<string, (typeof tags.$inferSelect)[]>();
	for (const row of allTagRows) {
		const { ideaId, ...tagRow } = row;
		if (!tagsByIdeaId.has(ideaId)) tagsByIdeaId.set(ideaId, []);
		tagsByIdeaId.get(ideaId)!.push(tagRow as typeof tags.$inferSelect);
	}

	const mediaByIdeaId = new Map<string, (typeof ideaMedia.$inferSelect)[]>();
	for (const row of allMediaRows) {
		if (!mediaByIdeaId.has(row.ideaId)) mediaByIdeaId.set(row.ideaId, []);
		mediaByIdeaId.get(row.ideaId)!.push(row);
	}

	return c.json(
		{
			data: data.map((row) =>
				serializeIdea(
					row,
					tagsByIdeaId.get(row.id) ?? [],
					mediaByIdeaId.get(row.id) ?? [],
				),
			),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Get idea ──────────────────────────────────────────────────────────────────

const getIdea = createRoute({
	operationId: "getIdea",
	method: "get",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Get an idea",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Idea details",
			content: { "application/json": { schema: IdeaResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [row] = await db
		.select()
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied as never;

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(serializeIdea(row, tagRows, mediaRows), 200);
});

// ── Create idea ───────────────────────────────────────────────────────────────

const createIdea = createRoute({
	operationId: "createIdea",
	method: "post",
	path: "/",
	tags: ["Ideas"],
	summary: "Create an idea",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateIdeaBody } },
		},
	},
	responses: {
		201: {
			description: "Idea created",
			content: { "application/json": { schema: IdeaResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(createIdea, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "idea");
	if (denied) return denied;

	// Resolve group ID
	const workspaceId = body.workspace_id ?? null;
	let groupId = body.group_id;
	if (!groupId) {
		groupId = await ensureDefaultGroup(db, orgId, workspaceId);
	}

	// Place at end of group
	const [result] = await db
		.select({ maxPos: max(ideas.position) })
		.from(ideas)
		.where(eq(ideas.groupId, groupId));
	const position = (result?.maxPos ?? 0) + 1;

	const [row] = await db
		.insert(ideas)
		.values({
			organizationId: orgId,
			workspaceId,
			groupId,
			title: body.title ?? null,
			content: body.content ?? null,
			position,
			assignedTo: body.assigned_to ?? null,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to create idea" },
			} as never,
			500 as never,
		);
	}

	// Associate tags
	if (body.tag_ids && body.tag_ids.length > 0) {
		await db.insert(ideaTags).values(
			body.tag_ids.map((tagId) => ({ ideaId: row.id, tagId })),
		);
	}

	// Log activity
	await logActivity(db, row.id, keyId, "created");

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, row.id),
		fetchIdeaMedia(db, row.id),
	]);

	return c.json(serializeIdea(row, tagRows, mediaRows), 201);
});

// ── Update idea ───────────────────────────────────────────────────────────────

const updateIdea = createRoute({
	operationId: "updateIdea",
	method: "patch",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Update an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea updated",
			content: { "application/json": { schema: IdeaResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateIdea, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	const activities: Array<(typeof ideaActivity.$inferInsert)["action"]> = [];

	if (body.title !== undefined) updates.title = body.title;
	if (body.content !== undefined) updates.content = body.content;
	if (body.assigned_to !== undefined) {
		updates.assignedTo = body.assigned_to;
		activities.push("assigned");
	}

	if (Object.keys(updates).length > 1) {
		// More than just updatedAt
		activities.push("updated");
		await db.update(ideas).set(updates).where(eq(ideas.id, id));
	}

	// Replace tags if provided
	if (body.tag_ids !== undefined) {
		await db.delete(ideaTags).where(eq(ideaTags.ideaId, id));
		if (body.tag_ids.length > 0) {
			await db.insert(ideaTags).values(
				body.tag_ids.map((tagId) => ({ ideaId: id, tagId })),
			);
		}
	}

	// Log activities
	for (const action of activities) {
		await logActivity(db, id, keyId, action);
	}

	const [updatedRow] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, id))
		.limit(1);

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(serializeIdea(updatedRow ?? existing, tagRows, mediaRows), 200);
});

// ── Delete idea ───────────────────────────────────────────────────────────────

const deleteIdea = createRoute({
	operationId: "deleteIdea",
	method: "delete",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Delete an idea",
	description: "Deletes an idea. FK cascades handle media, tags, comments, and activity.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Idea deleted" },
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(ideas).where(eq(ideas.id, id));

	return c.body(null, 204);
});

// ── Move idea ─────────────────────────────────────────────────────────────────

const moveIdea = createRoute({
	operationId: "moveIdea",
	method: "post",
	path: "/{id}/move",
	tags: ["Ideas"],
	summary: "Move an idea",
	description: "Reposition an idea within its group or move it to a different group.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: MoveIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea moved",
			content: { "application/json": { schema: IdeaResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(moveIdea, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const targetGroupId = body.group_id ?? existing.groupId;
	let targetPosition: number;

	if (body.after_idea_id) {
		// Place after specific idea — calculate midpoint
		const [afterIdea] = await db
			.select({ position: ideas.position })
			.from(ideas)
			.where(and(eq(ideas.id, body.after_idea_id), eq(ideas.groupId, targetGroupId)))
			.limit(1);

		if (!afterIdea) {
			// Fallback to end
			const [res] = await db
				.select({ maxPos: max(ideas.position) })
				.from(ideas)
				.where(eq(ideas.groupId, targetGroupId));
			targetPosition = (res?.maxPos ?? 0) + 1;
		} else {
			// Find the idea that comes after afterIdea to calculate midpoint
			const [nextIdea] = await db
				.select({ position: ideas.position })
				.from(ideas)
				.where(
					and(
						eq(ideas.groupId, targetGroupId),
						sql`${ideas.position} > ${afterIdea.position}`,
						sql`${ideas.id} != ${id}`,
					),
				)
				.orderBy(asc(ideas.position))
				.limit(1);

			if (nextIdea) {
				targetPosition = (afterIdea.position + nextIdea.position) / 2;
			} else {
				targetPosition = afterIdea.position + 1;
			}
		}
	} else if (body.position !== undefined) {
		targetPosition = body.position;
	} else {
		// Place at end of target group
		const [res] = await db
			.select({ maxPos: max(ideas.position) })
			.from(ideas)
			.where(
				and(
					eq(ideas.groupId, targetGroupId),
					sql`${ideas.id} != ${id}`,
				),
			);
		targetPosition = (res?.maxPos ?? 0) + 1;
	}

	await db
		.update(ideas)
		.set({ groupId: targetGroupId, position: targetPosition, updatedAt: new Date() })
		.where(eq(ideas.id, id));

	await logActivity(db, id, keyId, "moved", {
		from_group: existing.groupId,
		to_group: targetGroupId,
	});

	const [updatedRow] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, id))
		.limit(1);

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(serializeIdea(updatedRow ?? existing, tagRows, mediaRows), 200);
});

// ── Convert idea ──────────────────────────────────────────────────────────────

const convertIdea = createRoute({
	operationId: "convertIdea",
	method: "post",
	path: "/{id}/convert",
	tags: ["Ideas"],
	summary: "Convert an idea to a post",
	description: "Creates a draft post pre-filled from idea content and media.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: ConvertIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea converted to post",
			content: {
				"application/json": {
					schema: z.object({
						idea: IdeaResponse,
						post_id: z.string().describe("Newly created post ID"),
					}),
				},
			},
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(convertIdea, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	// Create a draft post pre-filled from the idea
	const postContent = body.content ?? existing.content ?? null;
	const [newPost] = await db
		.insert(posts)
		.values({
			organizationId: orgId,
			workspaceId: existing.workspaceId,
			content: postContent,
			status: "draft",
			timezone: body.timezone ?? "UTC",
		})
		.returning({ id: posts.id });

	if (!newPost) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create post" } } as never,
			500 as never,
		);
	}

	// Update idea's convertedToPostId
	await db
		.update(ideas)
		.set({ convertedToPostId: newPost.id, updatedAt: new Date() })
		.where(eq(ideas.id, id));

	await logActivity(db, id, keyId, "converted", { post_id: newPost.id });

	const [updatedRow] = await db
		.select()
		.from(ideas)
		.where(eq(ideas.id, id))
		.limit(1);

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(
		{
			idea: serializeIdea(updatedRow ?? existing, tagRows, mediaRows),
			post_id: newPost.id,
		},
		200,
	);
});

// ── Upload idea media ─────────────────────────────────────────────────────────

const uploadIdeaMedia = createRoute({
	operationId: "uploadIdeaMedia",
	method: "post",
	path: "/{id}/media",
	tags: ["Ideas"],
	summary: "Upload media to an idea",
	description: "Multipart form upload. Max 2MB.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						file: z.any().describe("File to upload"),
						alt: z.string().optional().describe("Alt text"),
					}),
				},
			},
			required: true,
		},
	},
	responses: {
		201: {
			description: "Media uploaded",
			content: { "application/json": { schema: IdeaMediaResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return additional error statuses
app.openapi(uploadIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	// Parse multipart form
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Request must be multipart/form-data" } },
			400,
		);
	}

	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Missing 'file' field" } },
			400,
		);
	}

	const MAX_SIZE = 2 * 1024 * 1024; // 2MB
	if (file.size > MAX_SIZE) {
		return c.json(
			{ error: { code: "FILE_TOO_LARGE", message: "Max upload size is 2MB" } },
			400,
		);
	}

	const altText = formData.get("alt");
	const alt = typeof altText === "string" ? altText : null;

	// Determine media type from MIME
	const mime = file.type.toLowerCase();
	let mediaType: "image" | "video" | "gif" | "document";
	if (mime === "image/gif") {
		mediaType = "gif";
	} else if (mime.startsWith("image/")) {
		mediaType = "image";
	} else if (mime.startsWith("video/")) {
		mediaType = "video";
	} else {
		mediaType = "document";
	}

	// Upload to R2
	const safeFilename = file.name
		.replace(/[/\\]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "")
		.replace(/[<>"'&]/g, "_");
	const storageKey = `ideas/${id}/${crypto.randomUUID()}-${safeFilename}`;

	const arrayBuffer = await file.arrayBuffer();
	await c.env.MEDIA_BUCKET.put(storageKey, arrayBuffer, {
		httpMetadata: { contentType: file.type },
	});

	const url = `https://media.relayapi.dev/${storageKey}`;

	// Get max position for this idea's media
	const [posResult] = await db
		.select({ maxPos: max(ideaMedia.position) })
		.from(ideaMedia)
		.where(eq(ideaMedia.ideaId, id));
	const position = (posResult?.maxPos ?? -1) + 1;

	const [mediaRow] = await db
		.insert(ideaMedia)
		.values({
			ideaId: id,
			url,
			type: mediaType,
			alt,
			position,
		})
		.returning();

	if (!mediaRow) {
		await c.env.MEDIA_BUCKET.delete(storageKey).catch(() => {});
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to save media" } } as never,
			500 as never,
		);
	}

	await logActivity(db, id, keyId, "media_added", {
		media_id: mediaRow.id,
		filename: file.name,
	});

	return c.json(serializeMedia(mediaRow), 201);
});

// ── Delete idea media ─────────────────────────────────────────────────────────

const IdeaMediaParam = z.object({ id: z.string(), media_id: z.string() });

const deleteIdeaMedia = createRoute({
	operationId: "deleteIdeaMedia",
	method: "delete",
	path: "/{id}/media/{media_id}",
	tags: ["Ideas"],
	summary: "Delete idea media",
	security: [{ Bearer: [] }],
	request: { params: IdeaMediaParam },
	responses: {
		204: { description: "Media deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id, media_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const [mediaRow] = await db
		.select()
		.from(ideaMedia)
		.where(and(eq(ideaMedia.id, media_id), eq(ideaMedia.ideaId, id)))
		.limit(1);

	if (!mediaRow) {
		return c.json(
			{ error: { code: "media_not_found", message: "Media not found" } },
			404,
		);
	}

	// Extract storage key from URL (https://media.relayapi.dev/{key})
	const storageKey = mediaRow.url.replace("https://media.relayapi.dev/", "");

	await Promise.all([
		c.env.MEDIA_BUCKET.delete(storageKey).catch(() => {}),
		db.delete(ideaMedia).where(eq(ideaMedia.id, media_id)),
	]);

	await logActivity(db, id, keyId, "media_removed", { media_id });

	return c.body(null, 204);
});

// ── List comments ─────────────────────────────────────────────────────────────

const listComments = createRoute({
	operationId: "listIdeaComments",
	method: "get",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "List comments on an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: IdeaCommentListQuery,
	},
	responses: {
		200: {
			description: "List of comments",
			content: { "application/json": { schema: IdeaCommentListResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listComments, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const conditions = [eq(ideaComments.ideaId, id)];
	if (cursor) {
		conditions.push(lt(ideaComments.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(ideaComments)
		.where(and(...conditions))
		.orderBy(desc(ideaComments.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((row) => ({
				id: row.id,
				author_id: row.authorId,
				content: row.content,
				parent_id: row.parentId ?? null,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			})),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Create comment ────────────────────────────────────────────────────────────

const createComment = createRoute({
	operationId: "createIdeaComment",
	method: "post",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "Add a comment to an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: CreateIdeaCommentBody } },
		},
	},
	responses: {
		201: {
			description: "Comment created",
			content: { "application/json": { schema: IdeaCommentResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 400 from threading validation
app.openapi(createComment, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	let parentId: string | null = null;
	if (body.parent_id) {
		// Validate parent exists and belongs to same idea
		const [parent] = await db
			.select({ id: ideaComments.id, parentId: ideaComments.parentId, ideaId: ideaComments.ideaId })
			.from(ideaComments)
			.where(eq(ideaComments.id, body.parent_id))
			.limit(1);

		if (!parent || parent.ideaId !== id) {
			return c.json(
				{ error: { code: "parent_not_found", message: "Parent comment not found on this idea" } },
				400,
			);
		}

		// Enforce one level of threading — parent must be a root comment
		if (parent.parentId !== null) {
			return c.json(
				{ error: { code: "THREADING_DEPTH_EXCEEDED", message: "Only one level of comment threading is supported" } },
				400,
			);
		}

		parentId = body.parent_id;
	}

	const [row] = await db
		.insert(ideaComments)
		.values({
			ideaId: id,
			authorId: keyId,
			content: body.content,
			parentId,
		})
		.returning();

	if (!row) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create comment" } } as never,
			500 as never,
		);
	}

	await logActivity(db, id, keyId, "commented", { comment_id: row.id });

	return c.json(
		{
			id: row.id,
			author_id: row.authorId,
			content: row.content,
			parent_id: row.parentId ?? null,
			created_at: row.createdAt.toISOString(),
			updated_at: row.updatedAt.toISOString(),
		},
		201,
	);
});

// ── Update comment ────────────────────────────────────────────────────────────

const IdeaCommentParam = z.object({ id: z.string(), comment_id: z.string() });

const updateComment = createRoute({
	operationId: "updateIdeaComment",
	method: "patch",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Edit a comment",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaCommentParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaCommentBody } },
		},
	},
	responses: {
		200: {
			description: "Comment updated",
			content: { "application/json": { schema: IdeaCommentResponse } },
		},
		403: {
			description: "Forbidden — not the comment author",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateComment, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id, comment_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const [comment] = await db
		.select()
		.from(ideaComments)
		.where(and(eq(ideaComments.id, comment_id), eq(ideaComments.ideaId, id)))
		.limit(1);

	if (!comment) {
		return c.json(
			{ error: { code: "comment_not_found", message: "Comment not found" } },
			404,
		);
	}

	// Only the author can edit
	if (comment.authorId !== keyId) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "You can only edit your own comments" } },
			403,
		);
	}

	const [updated] = await db
		.update(ideaComments)
		.set({ content: body.content, updatedAt: new Date() })
		.where(eq(ideaComments.id, comment_id))
		.returning();

	const row = updated ?? comment;
	return c.json(
		{
			id: row.id,
			author_id: row.authorId,
			content: row.content,
			parent_id: row.parentId ?? null,
			created_at: row.createdAt.toISOString(),
			updated_at: row.updatedAt.toISOString(),
		},
		200,
	);
});

// ── Delete comment ────────────────────────────────────────────────────────────

const deleteComment = createRoute({
	operationId: "deleteIdeaComment",
	method: "delete",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Delete a comment",
	description: "Deletes own comment. FK cascade handles child replies.",
	security: [{ Bearer: [] }],
	request: { params: IdeaCommentParam },
	responses: {
		204: { description: "Comment deleted" },
		403: {
			description: "Forbidden — not the comment author",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteComment, async (c) => {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id, comment_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const [comment] = await db
		.select({ id: ideaComments.id, authorId: ideaComments.authorId })
		.from(ideaComments)
		.where(and(eq(ideaComments.id, comment_id), eq(ideaComments.ideaId, id)))
		.limit(1);

	if (!comment) {
		return c.json(
			{ error: { code: "comment_not_found", message: "Comment not found" } },
			404,
		);
	}

	// Only the author can delete
	if (comment.authorId !== keyId) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "You can only delete your own comments" } },
			403,
		);
	}

	await db.delete(ideaComments).where(eq(ideaComments.id, comment_id));

	return c.body(null, 204);
});

// ── List activity ─────────────────────────────────────────────────────────────

const listActivity = createRoute({
	operationId: "listIdeaActivity",
	method: "get",
	path: "/{id}/activity",
	tags: ["Ideas"],
	summary: "List activity for an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: IdeaActivityListQuery,
	},
	responses: {
		200: {
			description: "List of activity events",
			content: { "application/json": { schema: IdeaActivityListResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listActivity, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const conditions = [eq(ideaActivity.ideaId, id)];
	if (cursor) {
		conditions.push(lt(ideaActivity.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(ideaActivity)
		.where(and(...conditions))
		.orderBy(desc(ideaActivity.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((row) => ({
				id: row.id,
				actor_id: row.actorId,
				action: row.action,
				metadata: row.metadata ?? null,
				created_at: row.createdAt.toISOString(),
			})),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

export { logActivity, fetchIdeaTags, fetchIdeaMedia, serializeIdea };
export default app;
