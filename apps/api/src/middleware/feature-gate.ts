import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";
import { hasAllWorkspaceScope } from "../lib/request-access";

export const proOnlyMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (c.get("plan") === "free") {
		return c.json(
			{
				error: {
					code: "PLAN_UPGRADE_REQUIRED",
					message:
						"This feature requires a Pro plan. Upgrade to access analytics, inbox, and more.",
				},
			},
			403,
		);
	}
	return next();
});

/**
 * Enforces workspace_id on create endpoints when the org has require_workspace_id enabled.
 * Only applies to POST (create methods). GET/PATCH/PUT/DELETE are not affected.
 * Checks an org-level KV key `org-settings:{orgId}` for the setting.
 */
export const workspaceRequiredMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	// Only enforce on POST (resource creation)
	if (c.req.method !== "POST") {
		return next();
	}

	// Fast in-memory short-circuits FIRST — a request that already carries a
	// workspace_id passes unconditionally, so skip the org-settings KV read
	// entirely on the hot create path. (Behavior is identical: the original
	// code returned next() for these requests regardless of the setting.)
	const url = new URL(c.req.url);
	const hasWorkspaceInQuery = url.searchParams.has("workspace_id");
	const body = c.get("parsedBody");
	const hasWorkspaceInBody = Boolean(body?.workspace_id);
	if (hasWorkspaceInQuery || hasWorkspaceInBody) {
		return next();
	}

	// No workspace_id present — determine whether it's required.
	// Scoped keys always require it (free, in-memory check). Only fall through
	// to the org-settings KV read when the key has all-workspace scope.
	const scopedKeyRequiresWorkspace = !hasAllWorkspaceScope(c);
	if (!scopedKeyRequiresWorkspace) {
		const orgId = c.get("orgId");
		const settings = await c.env.KV.get<{ require_workspace_id: boolean }>(
			`org-settings:${orgId}`,
			"json",
		);
		if (!settings?.require_workspace_id) {
			return next();
		}
	}

	// workspace_id is required but absent — return the appropriate error.
	if (body) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_ID_REQUIRED",
					message: scopedKeyRequiresWorkspace
						? "This API key is scoped to specific workspaces. Pass workspace_id in the request body or query string."
						: "This organization requires workspace_id on all create requests. Pass workspace_id in the request body or query string.",
				},
			},
			400,
		);
	}

	// Non-JSON body (e.g. multipart upload) without workspace_id in query
	return c.json(
		{
			error: {
				code: "WORKSPACE_ID_REQUIRED",
				message: scopedKeyRequiresWorkspace
					? "This API key is scoped to specific workspaces. Pass workspace_id as a query parameter."
					: "This organization requires workspace_id on all create requests. Pass workspace_id as a query parameter.",
			},
		},
		400,
	);
});

export const aiEnabledMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (!c.get("aiEnabled")) {
		return c.json(
			{
				error: {
					code: "AI_NOT_ENABLED",
					message:
						"AI features are not enabled for your organization. Contact your administrator to enable the AI add-on.",
				},
			},
			403,
		);
	}
	return next();
});
