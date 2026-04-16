import { workspaces } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

/**
 * Cross-tenant guard: when a request carries a workspace_id (in query string or
 * JSON body), verify it actually belongs to the caller's organization. Without
 * this, a key for org A could pass a workspace_id belonging to org B and have
 * the route handler tag resources under the foreign workspace.
 *
 * Runs a single SELECT against `workspaces` per request that mentions a
 * workspace_id. Requires bodyCacheMiddleware to have run first.
 */
export const workspaceValidationMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const workspaceIds: string[] = [];
	const queryWorkspaceId = new URL(c.req.url).searchParams.get("workspace_id");
	if (queryWorkspaceId) workspaceIds.push(queryWorkspaceId);

	const body = c.get("parsedBody");
	if (typeof body?.workspace_id === "string" && body.workspace_id.length > 0) {
		workspaceIds.push(body.workspace_id);
	}

	const uniqueWorkspaceIds = [...new Set(workspaceIds)];
	if (uniqueWorkspaceIds.length === 0) {
		return next();
	}

	const db = c.get("db");
	const rows = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.organizationId, c.get("orgId")),
				inArray(workspaces.id, uniqueWorkspaceIds),
			),
		)
		.limit(uniqueWorkspaceIds.length);

	if (rows.length !== uniqueWorkspaceIds.length) {
		return c.json(
			{
				error: {
					code: "INVALID_WORKSPACE",
					message: "Workspace not found",
				},
			},
			404,
		);
	}

	await next();
});
