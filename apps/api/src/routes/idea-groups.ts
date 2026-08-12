import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { type Database, ideaGroups, ideas } from "@relayapi/db";
import { and, asc, eq, sql } from "drizzle-orm";
import {
	assertAllWorkspaceScope,
	workspaceScopeKey,
} from "../lib/request-access";
import { applyWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateIdeaGroupBody,
	DeleteIdeaGroupQuery,
	IdeaGroupListQuery,
	IdeaGroupListResponse,
	IdeaGroupResponse,
	ReorderIdeaGroupsBody,
	UpdateIdeaGroupBody,
} from "../schemas/idea-groups";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

class IdeaGroupReorderFenceError extends Error {
	constructor() {
		super("Lost group reorder fence");
		this.name = "IdeaGroupReorderFenceError";
	}
}

function markIdeaGroupReorderNotApplied(
	c: Parameters<typeof assertAllWorkspaceScope>[0],
): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

function markIdeaGroupReorderCommitted(
	c: Parameters<typeof assertAllWorkspaceScope>[0],
): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
}

function markIdeaGroupReorderUnknown(
	c: Parameters<typeof assertAllWorkspaceScope>[0],
): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({ kind: "unknown" });
}

function serialize(row: typeof ideaGroups.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		position: row.position,
		color: row.color ?? null,
		is_default: row.isDefault,
		revision: row.revision,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function groupOrderLockKey(orgId: string, workspaceId: string | null): string {
	return `idea-groups:${orgId}:${workspaceScopeKey(workspaceId)}`;
}

function ideaOrderLockKey(
	orgId: string,
	scopeKey: string,
	groupId: string,
): string {
	return `idea-order:${orgId}:${scopeKey}:${groupId}`;
}

async function acquireAdvisoryLocks(
	db: Pick<Database, "execute">,
	keys: Iterable<string>,
): Promise<void> {
	for (const key of [...new Set(keys)].sort()) {
		await db.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
		);
	}
}

/**
 * Return the single default group for an exact scope, creating it only from a
 * write transaction that already holds groupOrderLockKey(). The partial unique
 * index is the final race fence; ON CONFLICT makes replay harmless.
 */
async function ensureDefaultGroup(
	db: Pick<Database, "select" | "insert">,
	orgId: string,
	workspaceId: string | null,
): Promise<string> {
	const scopeCondition = workspaceId
		? eq(ideaGroups.workspaceId, workspaceId)
		: sql`${ideaGroups.workspaceId} IS NULL`;
	const [existing] = await db
		.select({ id: ideaGroups.id })
		.from(ideaGroups)
		.where(
			and(
				eq(ideaGroups.organizationId, orgId),
				scopeCondition,
				eq(ideaGroups.isDefault, true),
			),
		)
		.limit(1);
	if (existing) return existing.id;

	const [created] = await db
		.insert(ideaGroups)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "Unassigned",
			position: sql`COALESCE((
				SELECT MAX(position) + 1
				FROM idea_groups
				WHERE organization_id = ${orgId}
					AND workspace_id IS NOT DISTINCT FROM ${workspaceId}
			), 0)`,
			isDefault: true,
		})
		.onConflictDoNothing()
		.returning({ id: ideaGroups.id });
	if (created) return created.id;

	// A concurrent writer may have won the partial unique constraint. This
	// statement gets a fresh READ COMMITTED snapshot after that conflict wait.
	const [winner] = await db
		.select({ id: ideaGroups.id })
		.from(ideaGroups)
		.where(
			and(
				eq(ideaGroups.organizationId, orgId),
				scopeCondition,
				eq(ideaGroups.isDefault, true),
			),
		)
		.limit(1);
	if (!winner) throw new Error("Failed to establish the default Idea group");
	return winner.id;
}

const listIdeaGroups = createRoute({
	operationId: "listIdeaGroups",
	method: "get",
	path: "/",
	tags: ["Idea Groups"],
	summary: "List idea groups",
	description:
		"Lists shared organization groups without mutating state. Every organization receives its default group during provisioning.",
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
	const conditions = [eq(ideaGroups.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideaGroups.workspaceId);
	if (workspace_id) {
		conditions.push(
			sql`(${ideaGroups.workspaceId} IS NULL OR ${ideaGroups.workspaceId} = ${workspace_id})`,
		);
	}
	const rows = await c
		.get("db")
		.select()
		.from(ideaGroups)
		.where(and(...conditions))
		.orderBy(asc(ideaGroups.position), asc(ideaGroups.id));
	return c.json({ data: rows.map(serialize) }, 200);
});

const createIdeaGroup = createRoute({
	operationId: "createIdeaGroup",
	method: "post",
	path: "/",
	tags: ["Idea Groups"],
	summary: "Create a shared idea group",
	description:
		"Idea groups are organization-shared definitions, so only an all-workspace API key can create them.",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateIdeaGroupBody } } },
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

app.openapi(createIdeaGroup, async (c) => {
	const denied = assertAllWorkspaceScope(
		c,
		"Only an all-workspace API key can create organization-shared Idea groups.",
	);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const row = await c.get("db").transaction(async (tx) => {
		await acquireAdvisoryLocks(tx, [groupOrderLockKey(orgId, null)]);
		const [created] = await tx
			.insert(ideaGroups)
			.values({
				organizationId: orgId,
				workspaceId: null,
				name: body.name,
				color: body.color ?? null,
				position: sql`COALESCE((
					SELECT MAX(position) + 1
					FROM idea_groups
					WHERE organization_id = ${orgId} AND workspace_id IS NULL
				), 0)`,
				isDefault: false,
			})
			.returning();
		if (!created) throw new Error("Failed to create Idea group");
		return created;
	});
	return c.json(serialize(row), 201);
});

const updateIdeaGroup = createRoute({
	operationId: "updateIdeaGroup",
	method: "patch",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Update an idea group",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: UpdateIdeaGroupBody } } },
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
		409: {
			description: "Revision conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateIdeaGroup, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const result = await c.get("db").transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(ideaGroups)
			.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!current) return { kind: "missing" } as const;
		if (current.revision !== body.expected_revision) {
			return { kind: "conflict" } as const;
		}
		if (body.name === undefined && body.color === undefined) {
			return { kind: "ok", row: current } as const;
		}
		const [updated] = await tx
			.update(ideaGroups)
			.set({
				...(body.name !== undefined ? { name: body.name } : {}),
				...(body.color !== undefined ? { color: body.color } : {}),
				revision: sql`${ideaGroups.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(ideaGroups.id, id),
					eq(ideaGroups.organizationId, orgId),
					eq(ideaGroups.revision, body.expected_revision),
				),
			)
			.returning();
		return updated
			? ({ kind: "ok", row: updated } as const)
			: ({ kind: "conflict" } as const);
	});
	if (result.kind === "missing") {
		return c.json(
			{
				error: {
					code: "idea_group_not_found",
					message: "Idea group not found",
				},
			},
			404,
		);
	}
	if (result.kind === "conflict") {
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message: "The Idea group changed; reload it and retry.",
				},
			},
			409 as never,
		);
	}
	return c.json(serialize(result.row), 200);
});

const deleteIdeaGroup = createRoute({
	operationId: "deleteIdeaGroup",
	method: "delete",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Delete an idea group",
	description:
		"Atomically moves every affected Idea to the exact-scope default group, then deletes the group. The default group cannot be deleted.",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: DeleteIdeaGroupQuery },
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
		409: {
			description: "Revision conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdeaGroup, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied as never;
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { expected_revision } = c.req.valid("query");
	const result = await c.get("db").transaction(async (tx) => {
		const [observed] = await tx
			.select({ workspaceId: ideaGroups.workspaceId })
			.from(ideaGroups)
			.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
			.limit(1);
		if (!observed) return { kind: "missing" } as const;

		// Group creation/reorder/delete all acquire the order lock before row
		// locks. Keeping that order prevents a delete/reorder lock cycle.
		await acquireAdvisoryLocks(tx, [
			groupOrderLockKey(orgId, observed.workspaceId),
		]);
		const [current] = await tx
			.select()
			.from(ideaGroups)
			.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!current) return { kind: "missing" } as const;
		if (
			current.workspaceId !== observed.workspaceId ||
			current.revision !== expected_revision
		) {
			return { kind: "conflict" } as const;
		}
		if (current.isDefault) return { kind: "default" } as const;
		const defaultGroupId = await ensureDefaultGroup(
			tx,
			orgId,
			current.workspaceId,
		);
		const [defaultGroup] = await tx
			.select({ scopeKey: ideaGroups.scopeKey })
			.from(ideaGroups)
			.where(
				and(
					eq(ideaGroups.id, defaultGroupId),
					eq(ideaGroups.organizationId, orgId),
				),
			)
			.limit(1);
		if (!defaultGroup) throw new Error("Default Idea group disappeared");

		const affectedScopes = await tx
			.selectDistinct({ scopeKey: ideas.scopeKey })
			.from(ideas)
			.where(and(eq(ideas.organizationId, orgId), eq(ideas.groupId, id)));
		await acquireAdvisoryLocks(
			tx,
			affectedScopes.flatMap(({ scopeKey }) => [
				ideaOrderLockKey(orgId, scopeKey, id),
				ideaOrderLockKey(orgId, scopeKey, defaultGroupId),
			]),
		);

		await tx.execute(sql`
			WITH ranked AS (
				SELECT source.id,
					source.scope_key,
					row_number() OVER (
						PARTITION BY source.scope_key
						ORDER BY source.position, source.id
					) AS ordinal
				FROM ideas AS source
				WHERE source.organization_id = ${orgId}
					AND source.group_id = ${id}
			), bases AS (
				SELECT target.scope_key, COALESCE(MAX(target.position), -1) AS base
				FROM ideas AS target
				WHERE target.organization_id = ${orgId}
					AND target.group_id = ${defaultGroupId}
				GROUP BY target.scope_key
			)
			UPDATE ideas AS target
			SET group_id = ${defaultGroupId},
				group_scope_key = ${defaultGroup.scopeKey},
				position = COALESCE(bases.base, -1) + ranked.ordinal,
				revision = target.revision + 1,
				updated_at = now()
			FROM ranked
			LEFT JOIN bases ON bases.scope_key = ranked.scope_key
			WHERE target.id = ranked.id
				AND target.organization_id = ${orgId}
		`);
		const deleted = await tx
			.delete(ideaGroups)
			.where(
				and(
					eq(ideaGroups.id, id),
					eq(ideaGroups.organizationId, orgId),
					eq(ideaGroups.revision, expected_revision),
				),
			)
			.returning({ id: ideaGroups.id });
		return deleted.length === 1
			? ({ kind: "deleted" } as const)
			: ({ kind: "conflict" } as const);
	});

	if (result.kind === "missing") {
		return c.json(
			{
				error: {
					code: "idea_group_not_found",
					message: "Idea group not found",
				},
			},
			404,
		);
	}
	if (result.kind === "default") {
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
	if (result.kind === "conflict") {
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message: "The Idea group changed; reload it and retry.",
				},
			},
			409 as never,
		);
	}
	return c.body(null, 204);
});

const reorderIdeaGroups = createRoute({
	operationId: "reorderIdeaGroups",
	method: "post",
	path: "/reorder",
	tags: ["Idea Groups"],
	summary: "Reorder shared idea groups",
	description:
		"Atomically replaces the complete organization-shared group order using per-group revision fences.",
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
		409: {
			description: "Revision or complete-set conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(reorderIdeaGroups, async (c) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) {
		markIdeaGroupReorderNotApplied(c);
		return denied as never;
	}
	const orgId = c.get("orgId");
	const { groups } = c.req.valid("json");
	const result = await (async () => {
		try {
			return await c.get("db").transaction(async (tx) => {
				await acquireAdvisoryLocks(tx, [groupOrderLockKey(orgId, null)]);
				const current = await tx
					.select()
					.from(ideaGroups)
					.where(
						and(
							eq(ideaGroups.organizationId, orgId),
							sql`${ideaGroups.workspaceId} IS NULL`,
						),
					)
					.orderBy(asc(ideaGroups.position), asc(ideaGroups.id))
					.for("update");
				const requested = new Map(groups.map((group) => [group.id, group]));
				const expectedPositions = new Set(
					groups.map((group) => group.position),
				);
				if (
					requested.size !== groups.length ||
					expectedPositions.size !== groups.length ||
					current.length !== groups.length ||
					groups.some((group) =>
						current.every(
							(row) =>
								row.id !== group.id || row.revision !== group.expected_revision,
						),
					) ||
					![...expectedPositions].every(
						(position) => position >= 0 && position < groups.length,
					)
				) {
					return { kind: "conflict" } as const;
				}

				const temporaryBase =
					Math.max(-1, ...current.map((group) => group.position)) +
					current.length +
					1;
				const temporaryValues = sql.join(
					current.map(
						(group, index) =>
							sql`(${group.id}::text, ${temporaryBase + index}::integer)`,
					),
					sql`, `,
				);
				await tx.execute(sql`
					UPDATE idea_groups AS target
					SET position = value.position
					FROM (VALUES ${temporaryValues}) AS value(id, position)
					WHERE target.id = value.id
						AND target.organization_id = ${orgId}
						AND target.workspace_id IS NULL
				`);

				const finalValues = sql.join(
					groups.map(
						(group) =>
							sql`(${group.id}::text, ${group.position}::integer, ${group.expected_revision}::integer)`,
					),
					sql`, `,
				);
				const updated = await tx.execute<{ id: string }>(sql`
					UPDATE idea_groups AS target
					SET position = value.position,
						revision = target.revision + 1,
						updated_at = now()
					FROM (VALUES ${finalValues}) AS value(id, position, expected_revision)
					WHERE target.id = value.id
						AND target.organization_id = ${orgId}
						AND target.workspace_id IS NULL
						AND target.revision = value.expected_revision
					RETURNING target.id
				`);
				if (updated.length !== groups.length)
					throw new IdeaGroupReorderFenceError();
				const rows = await tx
					.select()
					.from(ideaGroups)
					.where(
						and(
							eq(ideaGroups.organizationId, orgId),
							sql`${ideaGroups.workspaceId} IS NULL`,
						),
					)
					.orderBy(asc(ideaGroups.position), asc(ideaGroups.id));
				return { kind: "ok", rows } as const;
			});
		} catch (error) {
			if (error instanceof IdeaGroupReorderFenceError) {
				// The sentinel is thrown by our callback before the driver can issue
				// COMMIT, so the temporary-order writes necessarily roll back. Surface
				// the same reload-and-retry conflict as a pre-write revision mismatch.
				return { kind: "conflict" } as const;
			}
			// Raw SQL writes are inside the transaction. A rejected transaction
			// acknowledgement cannot distinguish rollback from a lost COMMIT ack.
			markIdeaGroupReorderUnknown(c);
			throw error;
		}
	})();
	if (result.kind === "conflict") {
		markIdeaGroupReorderNotApplied(c);
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message:
						"The group set or one of its revisions changed; reload and retry the complete order.",
				},
			},
			409 as never,
		);
	}
	markIdeaGroupReorderCommitted(c);
	return c.json({ data: result.rows.map(serialize) }, 200);
});

export {
	acquireAdvisoryLocks,
	ensureDefaultGroup,
	groupOrderLockKey,
	ideaOrderLockKey,
};
export default app;
