import type { SQL } from "drizzle-orm";
import { inArray, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import type { Env, Variables } from "../types";

/** Pure form of the row-level workspace authorization rule. */
export function canAccessWorkspaceScope(
	scope: "all" | string[],
	workspaceId: string | null,
): boolean {
	if (scope === "all") return true;
	if (scope.length === 0) return false;
	return workspaceId === null || scope.includes(workspaceId);
}

/** SQL equivalent of {@link canAccessWorkspaceScope}. */
export function workspaceScopeSqlCondition(
	scope: "all" | string[],
	workspaceIdColumn: PgColumn,
): SQL {
	if (scope === "all") return sql`true`;
	if (scope.length === 0) return sql`false`;
	return (
		or(isNull(workspaceIdColumn), inArray(workspaceIdColumn, scope)) ??
		sql`false`
	);
}

/**
 * Pushes a workspace filter into the conditions array when the API key is
 * scoped to specific workspaces. Organization-scoped rows (`workspace_id IS
 * NULL`) are shared across every non-empty workspace grant. A zero-grant key
 * sees nothing. No-op for "all" scope.
 */
export function applyWorkspaceScope(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	conditions: SQL[],
	workspaceIdColumn: PgColumn,
): void {
	const scope = c.get("workspaceScope");
	if (scope !== "all") {
		conditions.push(workspaceScopeSqlCondition(scope, workspaceIdColumn));
	}
}

/**
 * For single-resource endpoints: returns a 403 response if the resource's
 * workspaceId is not in the API key's workspace scope. Returns undefined
 * if access is allowed. No-op for "all" scope.
 */
export function assertWorkspaceScope(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	workspaceId: string | null,
): Response | undefined {
	const scope = c.get("workspaceScope");
	if (!canAccessWorkspaceScope(scope, workspaceId)) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_ACCESS_DENIED",
					message: "This API key does not have access to this workspace",
				},
			},
			403,
		);
	}
	return undefined;
}

/**
 * Boolean form for OpenAPI handlers — returns true when the API key does NOT
 * have access. The handler is responsible for returning the typed 403 body
 * itself (so the OpenAPI-typed response union stays correct):
 *
 *   if (isWorkspaceScopeDenied(c, row.workspaceId)) {
 *     return c.json({ error: { code: "WORKSPACE_ACCESS_DENIED", message: "..." } }, 403);
 *   }
 */
export function isWorkspaceScopeDenied(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	workspaceId: string | null,
): boolean {
	return !canAccessWorkspaceScope(c.get("workspaceScope"), workspaceId);
}

export const WORKSPACE_ACCESS_DENIED_BODY = {
	error: {
		code: "WORKSPACE_ACCESS_DENIED",
		message: "This API key does not have access to this workspace",
	},
} as const;
