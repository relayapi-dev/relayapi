import type { Context } from "hono";
import type { SQL } from "drizzle-orm";
import { inArray } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Env, Variables } from "../types";

/**
 * Pushes a workspace filter into the conditions array when the API key
 * is scoped to specific workspaces. No-op for "all" scope.
 */
export function applyWorkspaceScope(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	conditions: SQL[],
	workspaceIdColumn: PgColumn,
): void {
	const scope = c.get("workspaceScope");
	if (scope !== "all") {
		conditions.push(inArray(workspaceIdColumn, scope));
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
	if (scope === "all") return undefined;
	if (!workspaceId || !scope.includes(workspaceId)) {
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
	const scope = c.get("workspaceScope");
	if (scope === "all") return false;
	if (!workspaceId || !scope.includes(workspaceId)) return true;
	return false;
}

export const WORKSPACE_ACCESS_DENIED_BODY = {
	error: {
		code: "WORKSPACE_ACCESS_DENIED",
		message: "This API key does not have access to this workspace",
	},
} as const;
