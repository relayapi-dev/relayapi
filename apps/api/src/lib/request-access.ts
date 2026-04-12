import type { Context } from "hono";
import type { Env, Variables } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function hasWriteAccess(c: AppContext): boolean {
	return c.get("permissions").includes("write");
}

export function hasAllWorkspaceScope(c: AppContext): boolean {
	return c.get("workspaceScope") === "all";
}

export function assertWriteAccess(
	c: AppContext,
	message = "This API key has read-only permissions. Use a read-write key for this operation.",
): Response | undefined {
	if (hasWriteAccess(c)) return undefined;
	return c.json(
		{
			error: {
				code: "READ_ONLY",
				message,
			},
		},
		403,
	);
}

export function assertAllWorkspaceScope(
	c: AppContext,
	message = "This endpoint requires an API key with access to all workspaces.",
): Response | undefined {
	if (hasAllWorkspaceScope(c)) return undefined;
	return c.json(
		{
			error: {
				code: "ORG_LEVEL_ACCESS_REQUIRED",
				message,
			},
		},
		403,
	);
}

export function assertScopedCreateWorkspace(
	c: AppContext,
	workspaceId: string | null | undefined,
	resourceName = "resource",
): Response | undefined {
	const scope = c.get("workspaceScope");
	if (scope === "all") return undefined;

	if (!workspaceId) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_ID_REQUIRED",
					message: `This API key is scoped to specific workspaces. Pass workspace_id when creating a ${resourceName}.`,
				},
			},
			400,
		);
	}

	if (!scope.includes(workspaceId)) {
		return c.json(
			{
				error: {
					code: "WORKSPACE_ACCESS_DENIED",
					message: "This API key does not have access to the requested workspace.",
				},
			},
			403,
		);
	}

	return undefined;
}
