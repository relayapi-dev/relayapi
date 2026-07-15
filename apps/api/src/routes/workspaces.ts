import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import {
	type Database,
	socialAccounts,
	workspaceErasureJobs,
	workspaceErasureSteps,
	workspaces,
} from "@relayapi/db";
import { and, eq, ilike, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
	assertAllWorkspaceScope,
	assertWriteAccess,
} from "../lib/request-access";
import { workspaceValidKvKey } from "../middleware/workspace-validation";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateWorkspaceBody,
	UpdateWorkspaceBody,
	WorkspaceErasureRequestBody,
	WorkspaceErasureResponse,
	WorkspaceLifecycleBody,
	WorkspaceListQuery,
	WorkspaceListResponse,
	WorkspaceResponse,
} from "../schemas/workspaces";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

app.use("*", async (c, next) => {
	if (c.req.method === "GET") return next();

	const denied =
		assertWriteAccess(c) ??
		assertAllWorkspaceScope(
			c,
			"Managing workspaces requires an API key with access to all workspaces.",
		);
	if (denied) return denied;
	return next();
});

const WorkspaceConflictResponse = {
	description: "Workspace lifecycle or revision conflict",
	content: { "application/json": { schema: ErrorResponse } },
} as const;

const listWorkspaces = createRoute({
	operationId: "listWorkspaces",
	method: "get",
	path: "/",
	tags: ["Workspaces"],
	summary: "List workspaces",
	security: [{ Bearer: [] }],
	request: { query: WorkspaceListQuery },
	responses: {
		200: {
			description: "List of workspaces",
			content: { "application/json": { schema: WorkspaceListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createWorkspace = createRoute({
	operationId: "createWorkspace",
	method: "post",
	path: "/",
	tags: ["Workspaces"],
	summary: "Create a workspace",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateWorkspaceBody } } },
	},
	responses: {
		201: {
			description: "Workspace created",
			content: { "application/json": { schema: WorkspaceResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateWorkspace = createRoute({
	operationId: "updateWorkspace",
	method: "patch",
	path: "/{id}",
	tags: ["Workspaces"],
	summary: "Update a workspace",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: UpdateWorkspaceBody } } },
	},
	responses: {
		200: {
			description: "Workspace updated",
			content: { "application/json": { schema: WorkspaceResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: WorkspaceConflictResponse,
	},
});

const archiveWorkspace = createRoute({
	operationId: "archiveWorkspace",
	method: "post",
	path: "/{id}/archive",
	tags: ["Workspaces"],
	summary: "Archive a workspace",
	description:
		"Stops the workspace from accepting new operational resources without deleting its data.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: WorkspaceLifecycleBody } },
		},
	},
	responses: {
		200: {
			description: "Workspace archived",
			content: { "application/json": { schema: WorkspaceResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: WorkspaceConflictResponse,
	},
});

const restoreWorkspace = createRoute({
	operationId: "restoreWorkspace",
	method: "post",
	path: "/{id}/restore",
	tags: ["Workspaces"],
	summary: "Restore an archived workspace",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: WorkspaceLifecycleBody } },
		},
	},
	responses: {
		200: {
			description: "Workspace restored",
			content: { "application/json": { schema: WorkspaceResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: WorkspaceConflictResponse,
	},
});

const deleteWorkspace = createRoute({
	operationId: "deleteWorkspace",
	method: "delete",
	path: "/{id}",
	tags: ["Workspaces"],
	summary: "Request irreversible workspace erasure",
	description:
		"The workspace must be archived first. This creates an idempotent durable erasure operation; it does not delete data in the request transaction.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: WorkspaceErasureRequestBody } },
		},
	},
	responses: {
		202: {
			description: "Workspace erasure accepted",
			content: { "application/json": { schema: WorkspaceErasureResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: WorkspaceConflictResponse,
	},
});

type WorkspaceRow = typeof workspaces.$inferSelect;

async function workspaceResponse(
	db: Database,
	row: WorkspaceRow,
): Promise<z.infer<typeof WorkspaceResponse>> {
	const accountRows = await db
		.select({ id: socialAccounts.id })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.workspaceId, row.id),
				eq(socialAccounts.organizationId, row.organizationId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		);
	const accountIds = accountRows.map((account) => account.id);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		lifecycle_status: row.lifecycleStatus,
		revision: row.revision,
		archived_at: row.archivedAt?.toISOString() ?? null,
		erasure_requested_at: row.erasureRequestedAt?.toISOString() ?? null,
		account_ids: accountIds,
		account_count: accountIds.length,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function invalidateWorkspaceHint(c: AppContext, id: string) {
	c.executionCtx.waitUntil(
		c.env.KV.delete(workspaceValidKvKey(c.get("orgId"), id)),
	);
}

app.openapi(listWorkspaces, async (c) => {
	const orgId = c.get("orgId");
	const { search, lifecycle_status, limit, cursor } = c.req.valid("query");
	const db = c.get("db");
	const conditions = [eq(workspaces.organizationId, orgId)];
	const workspaceScope = c.get("workspaceScope");
	if (workspaceScope !== "all") {
		conditions.push(inArray(workspaces.id, workspaceScope));
	}
	if (lifecycle_status !== "all") {
		conditions.push(eq(workspaces.lifecycleStatus, lifecycle_status));
	}
	if (search) {
		conditions.push(
			ilike(workspaces.name, `%${search.replace(/[%_\\]/g, "\\$&")}%`),
		);
	}
	if (cursor) {
		conditions.push(
			sql`(${workspaces.name}, ${workspaces.id}) > ((select w.name from workspaces w where w.id = ${cursor}), ${cursor})`,
		);
	}

	const rows = await db
		.select({
			id: workspaces.id,
			organizationId: workspaces.organizationId,
			name: workspaces.name,
			description: workspaces.description,
			lifecycleStatus: workspaces.lifecycleStatus,
			revision: workspaces.revision,
			archivedAt: workspaces.archivedAt,
			erasureRequestedAt: workspaces.erasureRequestedAt,
			createdAt: workspaces.createdAt,
			updatedAt: workspaces.updatedAt,
			accountIds: sql<
				string[]
			>`coalesce(json_agg(${socialAccounts.id}) filter (where ${socialAccounts.id} is not null), '[]'::json)`,
		})
		.from(workspaces)
		.leftJoin(
			socialAccounts,
			and(
				eq(socialAccounts.workspaceId, workspaces.id),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.where(and(...conditions))
		.groupBy(workspaces.id)
		.orderBy(workspaces.name, workspaces.id)
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((row) => {
				const accountIds = Array.isArray(row.accountIds) ? row.accountIds : [];
				return {
					id: row.id,
					name: row.name,
					description: row.description,
					lifecycle_status: row.lifecycleStatus,
					revision: row.revision,
					archived_at: row.archivedAt?.toISOString() ?? null,
					erasure_requested_at: row.erasureRequestedAt?.toISOString() ?? null,
					account_ids: accountIds,
					account_count: accountIds.length,
					created_at: row.createdAt.toISOString(),
					updated_at: row.updatedAt.toISOString(),
				};
			}),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — handler also returns an internal error response
app.openapi(createWorkspace, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const [workspace] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: body.name,
			description: body.description ?? null,
		})
		.returning();
	if (!workspace) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create workspace",
				},
			},
			500,
		);
	}
	return c.json(await workspaceResponse(db, workspace), 201);
});

app.openapi(updateWorkspace, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const updates: {
		updatedAt: Date;
		revision: SQL;
		name?: string;
		description?: string | null;
	} = {
		updatedAt: new Date(),
		revision: sql`${workspaces.revision} + 1`,
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;

	const [updated] = await db
		.update(workspaces)
		.set(updates)
		.where(
			and(
				eq(workspaces.id, id),
				eq(workspaces.organizationId, orgId),
				eq(workspaces.revision, body.expected_revision),
				ne(workspaces.lifecycleStatus, "erasing"),
			),
		)
		.returning();
	if (updated) return c.json(await workspaceResponse(db, updated), 200);

	const [current] = await db
		.select({
			revision: workspaces.revision,
			status: workspaces.lifecycleStatus,
		})
		.from(workspaces)
		.where(and(eq(workspaces.id, id), eq(workspaces.organizationId, orgId)))
		.limit(1);
	if (!current) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Workspace not found" } },
			404,
		);
	}
	return c.json(
		{
			error: {
				code: "WORKSPACE_VERSION_CONFLICT",
				message: "Workspace changed; reload it before updating.",
				details: {
					current_revision: current.revision,
					lifecycle_status: current.status,
				},
			},
		} as never,
		409,
	);
});

async function transitionWorkspace(
	db: Database,
	organizationId: string,
	id: string,
	expectedRevision: number,
	from: "active" | "archived",
	to: "active" | "archived",
): Promise<WorkspaceRow | undefined> {
	const now = new Date();
	const [updated] = await db
		.update(workspaces)
		.set({
			lifecycleStatus: to,
			archivedAt: to === "archived" ? now : null,
			erasureRequestedAt: null,
			revision: sql`${workspaces.revision} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(workspaces.id, id),
				eq(workspaces.organizationId, organizationId),
				eq(workspaces.revision, expectedRevision),
				eq(workspaces.lifecycleStatus, from),
			),
		)
		.returning();
	return updated;
}

async function lifecycleConflict(c: AppContext, id: string): Promise<Response> {
	const [current] = await c
		.get("db")
		.select({
			revision: workspaces.revision,
			status: workspaces.lifecycleStatus,
		})
		.from(workspaces)
		.where(
			and(eq(workspaces.id, id), eq(workspaces.organizationId, c.get("orgId"))),
		)
		.limit(1);
	if (!current) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Workspace not found" } },
			404,
		);
	}
	return c.json(
		{
			error: {
				code: "WORKSPACE_LIFECYCLE_CONFLICT",
				message: "Workspace state or revision does not allow this transition.",
				details: {
					current_revision: current.revision,
					lifecycle_status: current.status,
				},
			},
		},
		409,
	);
}

app.openapi(archiveWorkspace, async (c) => {
	const { id } = c.req.valid("param");
	const { expected_revision } = c.req.valid("json");
	const db = c.get("db");
	const updated = await transitionWorkspace(
		db,
		c.get("orgId"),
		id,
		expected_revision,
		"active",
		"archived",
	);
	if (!updated) return (await lifecycleConflict(c, id)) as never;
	invalidateWorkspaceHint(c, id);
	return c.json(await workspaceResponse(db, updated), 200);
});

app.openapi(restoreWorkspace, async (c) => {
	const { id } = c.req.valid("param");
	const { expected_revision } = c.req.valid("json");
	const db = c.get("db");
	const updated = await transitionWorkspace(
		db,
		c.get("orgId"),
		id,
		expected_revision,
		"archived",
		"active",
	);
	if (!updated) return (await lifecycleConflict(c, id)) as never;
	invalidateWorkspaceHint(c, id);
	return c.json(await workspaceResponse(db, updated), 200);
});

app.openapi(deleteWorkspace, async (c) => {
	const organizationId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { expected_revision } = c.req.valid("json");
	const db = c.get("db");
	const result = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select()
			.from(workspaces)
			.where(
				and(
					eq(workspaces.id, id),
					eq(workspaces.organizationId, organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!existing) return { kind: "not_found" as const };

		if (existing.lifecycleStatus !== "erasing") {
			if (
				existing.lifecycleStatus !== "archived" ||
				existing.revision !== expected_revision
			) {
				return {
					kind: "conflict" as const,
					revision: existing.revision,
					status: existing.lifecycleStatus,
				};
			}
			const now = new Date();
			const [fenced] = await tx
				.update(workspaces)
				.set({
					lifecycleStatus: "erasing",
					erasureRequestedAt: now,
					revision: sql`${workspaces.revision} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(workspaces.id, id),
						eq(workspaces.organizationId, organizationId),
						eq(workspaces.revision, expected_revision),
						eq(workspaces.lifecycleStatus, "archived"),
					),
				)
				.returning({ id: workspaces.id });
			if (!fenced) throw new Error("Workspace erasure fence was lost");

			await tx
				.insert(workspaceErasureJobs)
				.values({
					workspaceId: id,
					organizationId,
					requestedBy: c.get("keyId"),
					auditSnapshot: {
						previous_lifecycle_status: existing.lifecycleStatus,
						previous_revision: existing.revision,
						requested_via: "api",
					},
				})
				.onConflictDoNothing({ target: workspaceErasureJobs.workspaceId });
			await tx
				.insert(workspaceErasureSteps)
				.values([
					{
						workspaceId: id,
						organizationId,
						stepKey: "lifecycle_fenced",
						status: "completed",
						completedAt: now,
					},
					{
						workspaceId: id,
						organizationId,
						stepKey: "revoke_external_resources",
					},
					{
						workspaceId: id,
						organizationId,
						stepKey: "purge_scoped_data",
					},
					{
						workspaceId: id,
						organizationId,
						stepKey: "write_tombstone",
					},
				])
				.onConflictDoNothing({
					target: [
						workspaceErasureSteps.workspaceId,
						workspaceErasureSteps.stepKey,
					],
				});
		}

		const [job] = await tx
			.select({
				operationId: workspaceErasureJobs.erasureOperationId,
				status: workspaceErasureJobs.status,
				requestedAt: workspaceErasureJobs.requestedAt,
			})
			.from(workspaceErasureJobs)
			.where(
				and(
					eq(workspaceErasureJobs.workspaceId, id),
					eq(workspaceErasureJobs.organizationId, organizationId),
				),
			)
			.limit(1);
		if (!job) throw new Error("Workspace erasure job was not persisted");
		return { kind: "accepted" as const, job };
	});

	if (result.kind === "not_found") {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Workspace not found" } },
			404,
		);
	}
	if (result.kind === "conflict") {
		const mustArchive = result.status === "active";
		return c.json(
			{
				error: {
					code: mustArchive
						? "WORKSPACE_MUST_BE_ARCHIVED"
						: "WORKSPACE_VERSION_CONFLICT",
					message: mustArchive
						? "Archive the workspace before requesting irreversible erasure."
						: "Workspace changed; reload it before requesting erasure.",
					details: {
						current_revision: result.revision,
						lifecycle_status: result.status,
					},
				},
			} as never,
			409,
		);
	}

	invalidateWorkspaceHint(c, id);
	return c.json(
		{
			workspace_id: id,
			erasure_operation_id: result.job.operationId,
			status: result.job.status,
			requested_at: result.job.requestedAt.toISOString(),
		},
		202,
	);
});

export default app;
