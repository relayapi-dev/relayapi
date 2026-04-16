import { workspaces } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

const WS_VALID_TTL_SECONDS = 300; // 5 minutes

export function workspaceValidKvKey(orgId: string, workspaceId: string): string {
	return `ws-valid:${orgId}:${workspaceId}`;
}

/**
 * Cross-tenant guard: when a request carries a workspace_id (in query string or
 * JSON body), verify it actually belongs to the caller's organization. Without
 * this, a key for org A could pass a workspace_id belonging to org B and have
 * the route handler tag resources under the foreign workspace.
 *
 * Positive validations are cached in KV for 5 min keyed by `ws-valid:{orgId}:{wsId}`
 * so the common case skips the DB round-trip. The workspace delete handler
 * invalidates this key; otherwise the short TTL bounds staleness.
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

	const orgId = c.get("orgId");

	// Check the KV cache for each id in parallel
	const cached = await Promise.all(
		uniqueWorkspaceIds.map((id) => c.env.KV.get(workspaceValidKvKey(orgId, id), "text")),
	);

	const missing = uniqueWorkspaceIds.filter((_, i) => cached[i] !== "1");
	if (missing.length === 0) {
		return next();
	}

	// Fall back to DB only for cache misses
	const db = c.get("db");
	const rows = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.organizationId, orgId),
				inArray(workspaces.id, missing),
			),
		)
		.limit(missing.length);

	if (rows.length !== missing.length) {
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

	// Cache positive results off the hot path
	c.executionCtx.waitUntil(
		Promise.all(
			missing.map((id) =>
				c.env.KV.put(workspaceValidKvKey(orgId, id), "1", {
					expirationTtl: WS_VALID_TTL_SECONDS,
				}),
			),
		),
	);

	await next();
});
