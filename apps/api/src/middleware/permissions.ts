import { member } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
	assertAllWorkspaceScope,
	assertWriteAccess,
	hasWriteAccess,
} from "../lib/request-access";
import type { Env, Variables } from "../types";
import { markMutationInputNotApplied } from "./mutation-validation";
import { collectWorkspaceIds } from "./workspace-validation";

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
		// hasWriteAccess(c) is false here, so assertWriteAccess always returns a
		// 403 Response (never undefined); the guard keeps that invariant explicit.
		const denied = assertWriteAccess(c);
		if (denied) return denied;
	}

	return next();
});

export const requireWriteAccessMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const denied = assertWriteAccess(c);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}
	return next();
});

export const requireAllWorkspaceScopeMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const denied = assertAllWorkspaceScope(c);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}
	return next();
});

/** API-key administration is deliberately separate from ordinary write access. */
export const requireManageApiKeysMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (c.get("permissions").includes("manage_api_keys")) return next();
	markMutationInputNotApplied(c);
	return c.json(
		{
			error: {
				code: "MANAGE_API_KEYS_REQUIRED",
				message: "This credential cannot manage organization API keys.",
			},
		},
		403,
	);
});

export type FinancialPermission =
	| "view_billing"
	| "manage_billing"
	| "manage_spend";

function roleHasFinancialPermission(
	role: string,
	permission: FinancialPermission,
): boolean {
	const roles = new Set(role.split(",").map((value) => value.trim()));
	if (roles.has("owner")) return true;
	return roles.has("admin") && permission === "manage_spend";
}

export async function hasLiveFinancialPermission(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	permission: FinancialPermission,
): Promise<boolean> {
	if (c.get("principalType") === "service") {
		return c.get("permissions").includes(permission);
	}
	const userId = c.get("principalUserId");
	if (!userId) return false;
	const [membership] = await c
		.get("db")
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.userId, userId), eq(member.organizationId, c.get("orgId"))),
		)
		.limit(1);
	return membership
		? roleHasFinancialPermission(membership.role, permission)
		: false;
}

function financialPermissionMiddleware(permission: FinancialPermission) {
	return createMiddleware<{ Bindings: Env; Variables: Variables }>(
		async (c, next) => {
			if (await hasLiveFinancialPermission(c, permission)) return next();
			// Global financial gates run before usage reservation, while a few
			// route-local rechecks deliberately run after it to close role-change
			// races. The latter are still pre-handler and therefore exact K=0.
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: `${permission.toUpperCase()}_REQUIRED`,
						message: `This credential requires the ${permission} financial scope.`,
					},
				},
				403,
			);
		},
	);
}

export const requireViewBillingMiddleware =
	financialPermissionMiddleware("view_billing");
export const requireManageBillingMiddleware =
	financialPermissionMiddleware("manage_billing");
export const requireManageSpendMiddleware =
	financialPermissionMiddleware("manage_spend");

/**
 * Enforces workspace scoping on API keys.
 * Keys with scope "all" pass through. Scoped keys are checked against
 * the workspace_id in query params (GET) or request body
 * (POST/PUT/PATCH/DELETE).
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
	} else if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
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

		// Also check defined JSON workspace fields, including bulk post items.
		const deniedWorkspace = collectWorkspaceIds(c.get("parsedBody")).find(
			(workspaceId) => !scope.includes(workspaceId),
		);
		if (deniedWorkspace) {
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
