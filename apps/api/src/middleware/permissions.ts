import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";
import {
	assertAllWorkspaceScope,
	assertWriteAccess,
	hasWriteAccess,
} from "../lib/request-access";

/**
 * Blocks mutating requests (POST/PUT/PATCH/DELETE) for read-only API keys.
 */
export const readOnlyMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (hasWriteAccess(c)) {
		return next();
	}

	const method = c.req.method;
	if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		return assertWriteAccess(c)!;
	}

	return next();
});

export const requireWriteAccessMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const denied = assertWriteAccess(c);
	if (denied) return denied;
	return next();
});

export const requireAllWorkspaceScopeMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) return denied;
	return next();
});

/**
 * Enforces workspace scoping on API keys.
 * Keys with scope "all" pass through. Scoped keys are checked against
 * the workspace_id in query params (GET) or request body (POST/PUT/PATCH).
 */
export const workspaceScopeMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const scope = c.get("workspaceScope");

	if (scope === "all") {
		return next();
	}

	const method = c.req.method;

	if (method === "GET") {
		const url = new URL(c.req.url);
		const requestedWs = url.searchParams.get("workspace_id");

		if (requestedWs && !scope.includes(requestedWs)) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_ACCESS_DENIED",
						message:
							"This API key does not have access to the requested workspace.",
					},
				},
				403,
			);
		}
	} else if (["POST", "PUT", "PATCH"].includes(method)) {
		// Check query param first (works for all content types)
		const url = new URL(c.req.url);
		const queryWs = url.searchParams.get("workspace_id");
		if (queryWs && !scope.includes(queryWs)) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_ACCESS_DENIED",
						message:
							"This API key does not have access to the requested workspace.",
					},
				},
				403,
			);
		}

		// Also check JSON body if present (uses pre-parsed body from middleware)
		const body = c.get("parsedBody");
		if (body?.workspace_id && !scope.includes(body.workspace_id as string)) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_ACCESS_DENIED",
						message:
							"This API key does not have access to the requested workspace.",
					},
				},
				403,
			);
		}
	}

	return next();
});
