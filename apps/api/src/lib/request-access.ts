import {
	apikey,
	type Database,
	member,
	ORGANIZATION_SCOPE_KEY,
	organization,
	organizationSettings,
	workspaces,
} from "@relayapi/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Context } from "hono";
import type { Env, Variables } from "../types";
import { parseApiKeyWorkspaceScope } from "./api-key-workspace-scope";
import { canAccessWorkspaceScope } from "./workspace-scope";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface LiveApiKeyAuthorization {
	apiKeyId: string;
	workspaceScope: "all" | string[];
	permissions: string[];
}

/**
 * Re-read the initiating API key from PostgreSQL instead of trusting an OAuth
 * capability's historical grant snapshot. Long-running connection flows use
 * this immediately before durable writes so disable, expiry, permission, and
 * workspace-grant changes take effect without waiting for the auth KV TTL.
 */
export async function loadLiveApiKeyAuthorization(
	database: Pick<Database, "select">,
	params: { apiKeyId: string; organizationId: string; requireWrite?: boolean },
): Promise<LiveApiKeyAuthorization | null> {
	const now = new Date();
	const [row] = await database
		.select({
			id: apikey.id,
			referenceId: apikey.referenceId,
			permissions: apikey.permissions,
			metadata: apikey.metadata,
		})
		.from(apikey)
		.innerJoin(
			organization,
			and(
				eq(organization.id, apikey.organizationId),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.where(
			and(
				eq(apikey.id, params.apiKeyId),
				eq(apikey.organizationId, params.organizationId),
				eq(apikey.enabled, true),
				or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
			),
		)
		.for("share")
		.limit(1);
	if (!row) return null;

	const permissions = (row.permissions ?? "read,write")
		.split(",")
		.map((permission) => permission.trim())
		.filter(Boolean);
	if (params.requireWrite !== false && !permissions.includes("write")) {
		return null;
	}

	const metadata =
		row.metadata &&
		typeof row.metadata === "object" &&
		!Array.isArray(row.metadata)
			? (row.metadata as Record<string, unknown>)
			: null;
	if (metadata?.principal_type === "dashboard_user") {
		if (!row.referenceId) return null;
		const [activeMembership] = await database
			.select({ id: member.id })
			.from(member)
			.where(
				and(
					eq(member.userId, row.referenceId),
					eq(member.organizationId, params.organizationId),
				),
			)
			.for("share")
			.limit(1);
		if (!activeMembership) return null;
	}

	const workspaceScope = parseApiKeyWorkspaceScope(row.metadata);
	if (workspaceScope === null) return null;
	return {
		apiKeyId: row.id,
		workspaceScope,
		permissions,
	};
}

export type PersistedOperationalScopeValidation =
	| {
			ok: true;
			authorization: LiveApiKeyAuthorization;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 409 | 500;
			code:
				| "CONNECTION_INITIATOR_INVALID"
				| "WORKSPACE_ACCESS_DENIED"
				| "WORKSPACE_ID_REQUIRED"
				| "INVALID_WORKSPACE"
				| "WORKSPACE_NOT_ACTIVE"
				| "ORG_SETTINGS_NOT_INITIALIZED";
			message: string;
	  };

/** Revalidate a scope carried across OAuth/bot boundaries against live state. */
export async function validatePersistedOperationalScope(
	database: Pick<Database, "select">,
	params: {
		apiKeyId: string;
		organizationId: string;
		workspaceId: string | null;
		resourceName?: string;
	},
): Promise<PersistedOperationalScopeValidation> {
	const authorization = await loadLiveApiKeyAuthorization(database, {
		apiKeyId: params.apiKeyId,
		organizationId: params.organizationId,
	});
	if (!authorization) {
		return {
			ok: false,
			status: 403,
			code: "CONNECTION_INITIATOR_INVALID",
			message:
				"The API key that initiated this connection is no longer authorized.",
		};
	}

	const [settings] = await database
		.select({ requireWorkspaceId: organizationSettings.requireWorkspaceId })
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, params.organizationId))
		.for("share")
		.limit(1);
	if (!settings) {
		return {
			ok: false,
			status: 500,
			code: "ORG_SETTINGS_NOT_INITIALIZED",
			message: "Organization settings are not initialized.",
		};
	}

	if (params.workspaceId === null && settings.requireWorkspaceId) {
		return {
			ok: false,
			status: 400,
			code: "WORKSPACE_ID_REQUIRED",
			message: `This organization requires workspace_id when creating a ${params.resourceName ?? "resource"}.`,
		};
	}
	if (
		!canAccessWorkspaceScope(authorization.workspaceScope, params.workspaceId)
	) {
		return {
			ok: false,
			status: 403,
			code: "WORKSPACE_ACCESS_DENIED",
			message: "This API key does not have access to this workspace.",
		};
	}

	if (params.workspaceId !== null) {
		const [workspace] = await database
			.select({ lifecycleStatus: workspaces.lifecycleStatus })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.id, params.workspaceId),
					eq(workspaces.organizationId, params.organizationId),
				),
			)
			.for("share")
			.limit(1);
		if (!workspace) {
			return {
				ok: false,
				status: 404,
				code: "INVALID_WORKSPACE",
				message: "Workspace not found.",
			};
		}
		if (workspace.lifecycleStatus !== "active") {
			return {
				ok: false,
				status: 409,
				code: "WORKSPACE_NOT_ACTIVE",
				message: "The requested workspace is not active.",
			};
		}
	}

	return { ok: true, authorization };
}

export function hasWriteAccess(c: AppContext): boolean {
	return c.get("permissions").includes("write");
}

export function hasAllWorkspaceScope(c: AppContext): boolean {
	return c.get("workspaceScope") === "all";
}

/** Exact-scope discriminator shared with generated database scope columns. */
export function workspaceScopeKey(workspaceId: string | null): string {
	return workspaceId ? `ws/${workspaceId}` : ORGANIZATION_SCOPE_KEY;
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

export type OperationalCreateScopeDecision =
	| { ok: true; workspaceId: string | null }
	| {
			ok: false;
			status: 400 | 403;
			code: "WORKSPACE_ID_REQUIRED" | "WORKSPACE_ACCESS_DENIED";
			message: string;
	  };

/**
 * Pure policy decision used by the DB-backed resolver below.
 *
 * Organization policy and credential scope are deliberately independent:
 * - required mode rejects a null workspace candidate (a parent-aware resolver
 *   may supply an authoritative parent workspace before this decision);
 * - optional mode always treats an omitted ID as organization scope;
 * - an explicitly supplied ID must still be authorized for the credential;
 * - a credential with no workspace grants has no usable organization scope.
 */
export function decideOperationalCreateScope(params: {
	requireWorkspaceId: boolean;
	workspaceScope: "all" | string[];
	requestedWorkspaceId: string | null | undefined;
	resourceName?: string;
}): OperationalCreateScopeDecision {
	const resourceName = params.resourceName ?? "resource";
	const requestedWorkspaceId = params.requestedWorkspaceId?.trim() || null;

	if (requestedWorkspaceId) {
		if (
			params.workspaceScope !== "all" &&
			!params.workspaceScope.includes(requestedWorkspaceId)
		) {
			return {
				ok: false,
				status: 403,
				code: "WORKSPACE_ACCESS_DENIED",
				message:
					"This API key does not have access to the requested workspace.",
			};
		}
		return { ok: true, workspaceId: requestedWorkspaceId };
	}

	if (params.requireWorkspaceId) {
		return {
			ok: false,
			status: 400,
			code: "WORKSPACE_ID_REQUIRED",
			message: `This organization requires workspace_id when creating a ${resourceName}.`,
		};
	}

	if (params.workspaceScope === "all" || params.workspaceScope.length > 0) {
		return { ok: true, workspaceId: null };
	}

	return {
		ok: false,
		status: 403,
		code: "WORKSPACE_ACCESS_DENIED",
		message: `This API key has no workspace grant that can authorize creating a ${resourceName}.`,
	};
}

export type OperationalCreateScopeResolution =
	| {
			ok: true;
			workspaceId: string | null;
			settingsRevision: number;
	  }
	| { ok: false; response: Response };

export type ParentBoundCreateScopeDecision =
	| { ok: true; requestedWorkspaceId: string | null }
	| {
			ok: false;
			code: "WORKSPACE_SCOPE_CONFLICT";
			message: string;
	  };

/**
 * Select the workspace identity that a parent-bound root must validate.
 *
 * A single authoritative parent can supply the omitted workspace in both
 * optional and required mode. Explicit workspace IDs never override a parent:
 * they must match it exactly. An independent root (no parent scopes) passes an
 * omitted ID through to the ordinary resolver, which is where strict mode
 * returns WORKSPACE_ID_REQUIRED.
 */
export function decideParentBoundCreateScope(params: {
	requestedWorkspaceId: string | null | undefined;
	parentWorkspaceIds: Iterable<string | null>;
	resourceName?: string;
}): ParentBoundCreateScopeDecision {
	const resourceName = params.resourceName ?? "resource";
	const requestedWorkspaceId = params.requestedWorkspaceId?.trim() || null;
	const parentScopes = [...new Set(params.parentWorkspaceIds)];

	if (parentScopes.length > 1) {
		return {
			ok: false,
			code: "WORKSPACE_SCOPE_CONFLICT",
			message: `The selected parents do not share one workspace for this ${resourceName}.`,
		};
	}

	const hasParent = parentScopes.length === 1;
	const parentWorkspaceId = parentScopes[0] ?? null;
	if (hasParent && requestedWorkspaceId !== null) {
		if (requestedWorkspaceId !== parentWorkspaceId) {
			return {
				ok: false,
				code: "WORKSPACE_SCOPE_CONFLICT",
				message: `The requested workspace does not match the authoritative parent for this ${resourceName}.`,
			};
		}
		return { ok: true, requestedWorkspaceId };
	}

	return {
		ok: true,
		requestedWorkspaceId: hasParent ? parentWorkspaceId : requestedWorkspaceId,
	};
}

/**
 * Resolve an operational root whose scope may be supplied by an authoritative
 * parent. Parent inheritance runs before organization strict-mode validation,
 * so a single non-null parent satisfies Require Workspace ID without forcing a
 * redundant request field.
 */
export async function inheritOperationalCreateScope(
	c: AppContext,
	requestedWorkspaceId: string | null | undefined,
	parentWorkspaceIds: Iterable<string | null>,
	resourceName = "resource",
	database: Database = c.get("db"),
): Promise<OperationalCreateScopeResolution> {
	const decision = decideParentBoundCreateScope({
		requestedWorkspaceId,
		parentWorkspaceIds,
		resourceName,
	});
	if (!decision.ok) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: decision.code,
						message: decision.message,
					},
				},
				400,
			),
		};
	}

	return resolveOperationalCreateScope(
		c,
		decision.requestedWorkspaceId,
		resourceName,
		database,
	);
}

/**
 * Resolve the canonical scope for an operational root create.
 *
 * Callers that create inside a transaction should pass that transaction cast as
 * Database so the settings share-lock is held through the insert. The database
 * constraint remains the final backstop; this resolver supplies stable API
 * errors and validates that the chosen workspace is active and tenant-owned.
 */
export async function resolveOperationalCreateScope(
	c: AppContext,
	requestedWorkspaceId: string | null | undefined,
	resourceName = "resource",
	database: Database = c.get("db"),
): Promise<OperationalCreateScopeResolution> {
	const organizationId = c.get("orgId");
	const [settings] = await database
		.select({
			requireWorkspaceId: organizationSettings.requireWorkspaceId,
			revision: organizationSettings.revision,
		})
		.from(organizationSettings)
		.where(eq(organizationSettings.organizationId, organizationId))
		.for("share")
		.limit(1);

	if (!settings) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "ORG_SETTINGS_NOT_INITIALIZED",
						message: "Organization settings are not initialized.",
					},
				},
				500,
			),
		};
	}

	const decision = decideOperationalCreateScope({
		requireWorkspaceId: settings.requireWorkspaceId,
		workspaceScope: c.get("workspaceScope"),
		requestedWorkspaceId,
		resourceName,
	});
	if (!decision.ok) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: decision.code,
						message: decision.message,
					},
				},
				decision.status,
			),
		};
	}

	if (!decision.workspaceId) {
		return {
			ok: true,
			workspaceId: null,
			settingsRevision: settings.revision,
		};
	}

	const [workspace] = await database
		.select({
			id: workspaces.id,
			lifecycleStatus: workspaces.lifecycleStatus,
		})
		.from(workspaces)
		.where(
			and(
				eq(workspaces.id, decision.workspaceId),
				eq(workspaces.organizationId, organizationId),
			),
		)
		.limit(1);

	if (!workspace) {
		return {
			ok: false,
			response: c.json(
				{
					error: { code: "INVALID_WORKSPACE", message: "Workspace not found" },
				},
				404,
			),
		};
	}

	if (workspace.lifecycleStatus !== "active") {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "WORKSPACE_NOT_ACTIVE",
						message: "The requested workspace is not active.",
					},
				},
				409,
			),
		};
	}

	return {
		ok: true,
		workspaceId: workspace.id,
		settingsRevision: settings.revision,
	};
}
