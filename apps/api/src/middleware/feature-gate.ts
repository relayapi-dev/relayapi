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

	const orgId = c.get("orgId");

	// Check org-level setting from KV (fast, cached)
	const settings = await c.env.KV.get<{ require_workspace_id: boolean }>(
		`org-settings:${orgId}`,
		"json",
	);

	const scopedKeyRequiresWorkspace = !hasAllWorkspaceScope(c);
	if (!settings?.require_workspace_id && !scopedKeyRequiresWorkspace) {
		return next();
	}

	// Check query param first (works for all content types)
	const url = new URL(c.req.url);
	if (url.searchParams.has("workspace_id")) {
		return next();
	}

	// Check pre-parsed JSON body for workspace_id
	const body = c.get("parsedBody");
	if (body) {
		if (!body.workspace_id) {
			return c.json(
				{
					error: {
						code: "WORKSPACE_ID_REQUIRED",
						message:
							scopedKeyRequiresWorkspace
								? "This API key is scoped to specific workspaces. Pass workspace_id in the request body or query string."
								: "This organization requires workspace_id on all create requests. Pass workspace_id in the request body or query string.",
					},
				},
				400,
			);
		}
	} else {
		// Non-JSON body (e.g. multipart upload) without workspace_id in query
		return c.json(
				{
					error: {
						code: "WORKSPACE_ID_REQUIRED",
						message:
							scopedKeyRequiresWorkspace
								? "This API key is scoped to specific workspaces. Pass workspace_id as a query parameter."
								: "This organization requires workspace_id on all create requests. Pass workspace_id as a query parameter.",
					},
				},
				400,
			);
	}

	return next();
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
