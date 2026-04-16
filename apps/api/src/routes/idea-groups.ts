import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, ideaGroups, ideas } from "@relayapi/db";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateIdeaGroupBody,
	UpdateIdeaGroupBody,
	ReorderIdeaGroupsBody,
	IdeaGroupResponse,
	IdeaGroupListQuery,
	IdeaGroupListResponse,
} from "../schemas/idea-groups";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function serialize(row: typeof ideaGroups.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		position: row.position,
		color: row.color ?? null,
		is_default: row.isDefault,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function ensureDefaultGroup(
	db: ReturnType<typeof createDb>,
	orgId: string,
	workspaceId: string | null,
): Promise<string> {
	const conditions = [
		eq(ideaGroups.organizationId, orgId),
		eq(ideaGroups.isDefault, true),
	];
	if (workspaceId) {
		conditions.push(eq(ideaGroups.workspaceId, workspaceId));
	} else {
		conditions.push(sql`${ideaGroups.workspaceId} IS NULL`);
	}

	const [existing] = await db
		.select({ id: ideaGroups.id })
		.from(ideaGroups)
		.where(and(...conditions))
		.limit(1);

	if (existing) return existing.id;

	const [created] = await db
		.insert(ideaGroups)
		.values({
			organizationId: orgId,
			workspaceId: workspaceId,
			name: "Unassigned",
			position: 0,
			isDefault: true,
		})
		.returning({ id: ideaGroups.id });

	return created!.id;
}

// ── List idea groups ──────────────────────────────────────────────────────────

const listIdeaGroups = createRoute({
	operationId: "listIdeaGroups",
	method: "get",
	path: "/",
	tags: ["Idea Groups"],
	summary: "List idea groups",
	security: [{ Bearer: [] }],
	request: { query: IdeaGroupListQuery },
	responses: {
		200: {
			description: "List of idea groups",
			content: { "application/json": { schema: IdeaGroupListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listIdeaGroups, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const scopedWorkspaceId = workspace_id ?? null;
	await ensureDefaultGroup(db, orgId, scopedWorkspaceId);

	const conditions = [eq(ideaGroups.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideaGroups.workspaceId);
	if (workspace_id) {
		conditions.push(eq(ideaGroups.workspaceId, workspace_id));
	}

	const rows = await db
		.select()
		.from(ideaGroups)
		.where(and(...conditions))
		.orderBy(asc(ideaGroups.position));

	return c.json({ data: rows.map(serialize) }, 200);
});

// ── Create idea group ─────────────────────────────────────────────────────────

const createIdeaGroup = createRoute({
	operationId: "createIdeaGroup",
	method: "post",
	path: "/",
	tags: ["Idea Groups"],
	summary: "Create an idea group",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateIdeaGroupBody } },
		},
	},
	responses: {
		201: {
			description: "Idea group created",
			content: { "application/json": { schema: IdeaGroupResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(createIdeaGroup, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "idea group");
	if (denied) return denied;

	let position = body.position;
	if (position === undefined) {
		const [result] = await db
			.select({ maxPos: max(ideaGroups.position) })
			.from(ideaGroups)
			.where(
				and(
					eq(ideaGroups.organizationId, orgId),
					body.workspace_id
						? eq(ideaGroups.workspaceId, body.workspace_id)
						: sql`${ideaGroups.workspaceId} IS NULL`,
				),
			);
		position = (result?.maxPos ?? 0) + 1;
	}

	const [row] = await db
		.insert(ideaGroups)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			color: body.color ?? null,
			position,
			isDefault: false,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create idea group",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

// ── Update idea group ─────────────────────────────────────────────────────────

const updateIdeaGroup = createRoute({
	operationId: "updateIdeaGroup",
	method: "patch",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Update an idea group",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaGroupBody } },
		},
	},
	responses: {
		200: {
			description: "Idea group updated",
			content: { "application/json": { schema: IdeaGroupResponse } },
		},
		404: {
			description: "Idea group not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateIdeaGroup, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(ideaGroups)
		.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_group_not_found", message: "Idea group not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = {};
	if (body.name !== undefined) updates.name = body.name;
	if (body.color !== undefined) updates.color = body.color;
	updates.updatedAt = new Date();

	if (Object.keys(updates).length === 1) {
		// Only updatedAt was set — nothing meaningful to update
		return c.json(serialize(existing), 200);
	}

	const [updated] = await db
		.update(ideaGroups)
		.set(updates)
		.where(eq(ideaGroups.id, id))
		.returning();

	return c.json(serialize(updated ?? existing), 200);
});

// ── Delete idea group ─────────────────────────────────────────────────────────

const deleteIdeaGroup = createRoute({
	operationId: "deleteIdeaGroup",
	method: "delete",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Delete an idea group",
	description:
		"Deletes an idea group and moves all ideas in that group to the default 'Unassigned' group. Cannot delete the default group.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Idea group deleted" },
		400: {
			description: "Cannot delete default group",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea group not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdeaGroup, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(ideaGroups)
		.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_group_not_found", message: "Idea group not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	if (existing.isDefault) {
		return c.json(
			{
				error: {
					code: "CANNOT_DELETE_DEFAULT_GROUP",
					message: "Cannot delete the default 'Unassigned' group",
				},
			},
			400,
		);
	}

	// Move all ideas in this group to the default group
	const defaultGroupId = await ensureDefaultGroup(db, orgId, existing.workspaceId);
	const [positionResult] = await db
		.select({ maxPos: max(ideas.position) })
		.from(ideas)
		.where(eq(ideas.groupId, defaultGroupId));

	const ideasToMove = await db
		.select({ id: ideas.id })
		.from(ideas)
		.where(eq(ideas.groupId, id))
		.orderBy(asc(ideas.position));

	await Promise.all(
		ideasToMove.map((idea, index) =>
			db
				.update(ideas)
				.set({
					groupId: defaultGroupId,
					position: (positionResult?.maxPos ?? -1) + index + 1,
					updatedAt: new Date(),
				})
				.where(eq(ideas.id, idea.id)),
		),
	);

	await db.delete(ideaGroups).where(eq(ideaGroups.id, id));

	return c.body(null, 204);
});

// ── Reorder idea groups ───────────────────────────────────────────────────────

const reorderIdeaGroups = createRoute({
	operationId: "reorderIdeaGroups",
	method: "post",
	path: "/reorder",
	tags: ["Idea Groups"],
	summary: "Reorder idea groups",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ReorderIdeaGroupsBody } },
		},
	},
	responses: {
		200: {
			description: "Idea groups reordered",
			content: { "application/json": { schema: IdeaGroupListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(reorderIdeaGroups, async (c) => {
	const orgId = c.get("orgId");
	const { groups } = c.req.valid("json");
	const db = c.get("db");

	// Bulk update positions — only update groups that belong to this org
	await Promise.all(
		groups.map(({ id, position }) =>
			db
				.update(ideaGroups)
				.set({ position, updatedAt: new Date() })
				.where(
					and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)),
				),
		),
	);

	// Return the full list ordered by position
	const conditions = [eq(ideaGroups.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideaGroups.workspaceId);

	const rows = await db
		.select()
		.from(ideaGroups)
		.where(and(...conditions))
		.orderBy(asc(ideaGroups.position));

	return c.json({ data: rows.map(serialize) }, 200);
});

export { ensureDefaultGroup };
export default app;
