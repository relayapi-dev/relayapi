import { hasCurrentDashboardCredentialPermissions } from "@relayapi/config";
import {
	apikey,
	session as authSession,
	type Database,
	LEGACY_CREDENTIAL_VERSION,
	member,
	ORGANIZATION_SCOPE_KEY,
	organization,
	organizationPrincipals,
	organizationSettings,
	principalWorkspaceGrants,
	user,
	workspaces,
} from "@relayapi/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Env, Variables } from "../types";
import { canAccessWorkspaceScope } from "./workspace-scope";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export interface LiveApiKeyAuthorization {
	apiKeyId: string;
	workspaceScope: "all" | string[];
	permissions: string[];
}

/**
 * Re-read the initiating API key from PostgreSQL instead of trusting an OAuth
 * capability's historical grant snapshot. Long-running connection flows call
 * this with their write transaction immediately before durable writes, locking
 * the user, membership, organization, exact key/principal, and workspace
 * grants. Bans, generation rotation, membership removal, expiry, permission,
 * and scope changes therefore linearize with provider-credential persistence.
 */
export async function loadLiveApiKeyAuthorization(
	database: Pick<Database, "select">,
	params: {
		apiKeyId: string;
		organizationId: string;
		requireWrite?: boolean;
		/**
		 * Exact Better Auth session carried by a credential-granting flow.
		 * `undefined` preserves legacy key-only checks for non-credential callers;
		 * `null` explicitly requires a service principal.
		 */
		authoritySessionId?: string | null;
	},
): Promise<LiveApiKeyAuthorization | null> {
	const [discovered] = await database
		.select({
			id: apikey.id,
			referenceId: apikey.referenceId,
			principalId: apikey.principalId,
			principalKind: organizationPrincipals.kind,
			principalMemberId: organizationPrincipals.memberId,
		})
		.from(apikey)
		.innerJoin(
			organizationPrincipals,
			and(
				eq(organizationPrincipals.id, apikey.principalId),
				eq(organizationPrincipals.organizationId, apikey.organizationId),
				eq(organizationPrincipals.lifecycleStatus, "active"),
			),
		)
		.where(
			and(
				eq(apikey.id, params.apiKeyId),
				eq(apikey.organizationId, params.organizationId),
			),
		)
		.limit(1);
	if (!discovered) return null;

	let lockedUser:
		| {
				id: string;
				banned: boolean | null;
				banExpires: Date | null;
				credentialVersion: string;
		  }
		| undefined;
	let lockedMember:
		| { id: string; role: string; userId: string; organizationId: string }
		| undefined;
	if (discovered.principalKind === "member") {
		if (!discovered.referenceId || !discovered.principalMemberId) return null;
		[lockedUser] = await database
			.select({
				id: user.id,
				banned: user.banned,
				banExpires: user.banExpires,
				credentialVersion: user.credentialVersion,
			})
			.from(user)
			.where(eq(user.id, discovered.referenceId))
			.for("share")
			.limit(1);
		[lockedMember] = await database
			.select({
				id: member.id,
				role: member.role,
				userId: member.userId,
				organizationId: member.organizationId,
			})
			.from(member)
			.where(
				and(
					eq(member.id, discovered.principalMemberId),
					eq(member.organizationId, params.organizationId),
					eq(member.userId, discovered.referenceId),
				),
			)
			.for("share")
			.limit(1);
	}

	const [lockedOrganization] = await database
		.select({ lifecycleStatus: organization.lifecycleStatus })
		.from(organization)
		.where(eq(organization.id, params.organizationId))
		.for("share")
		.limit(1);
	const [lockedKey] = await database
		.select({
			id: apikey.id,
			referenceId: apikey.referenceId,
			principalId: apikey.principalId,
			credentialVersion: apikey.credentialVersion,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			permissions: apikey.permissions,
		})
		.from(apikey)
		.where(
			and(
				eq(apikey.id, params.apiKeyId),
				eq(apikey.organizationId, params.organizationId),
				eq(apikey.principalId, discovered.principalId),
			),
		)
		.for("share")
		.limit(1);
	const [lockedPrincipal] = await database
		.select({
			id: organizationPrincipals.id,
			kind: organizationPrincipals.kind,
			memberId: organizationPrincipals.memberId,
			scopeMode: organizationPrincipals.scopeMode,
			lifecycleStatus: organizationPrincipals.lifecycleStatus,
		})
		.from(organizationPrincipals)
		.where(
			and(
				eq(organizationPrincipals.id, discovered.principalId),
				eq(organizationPrincipals.organizationId, params.organizationId),
			),
		)
		.for("share")
		.limit(1);
	if (
		lockedOrganization?.lifecycleStatus !== "active" ||
		!lockedKey ||
		lockedKey.enabled !== true ||
		!lockedPrincipal ||
		lockedPrincipal.lifecycleStatus !== "active" ||
		lockedPrincipal.kind !== discovered.principalKind ||
		lockedPrincipal.memberId !== discovered.principalMemberId
	) {
		return null;
	}

	const permissions = (lockedKey.permissions ?? "read,write")
		.split(",")
		.map((permission) => permission.trim())
		.filter(Boolean);
	if (params.requireWrite !== false && !permissions.includes("write")) {
		return null;
	}
	if (lockedPrincipal.kind === "member") {
		const userCredentialVersion =
			lockedUser?.credentialVersion || LEGACY_CREDENTIAL_VERSION;
		const keyCredentialVersion =
			lockedKey.credentialVersion || LEGACY_CREDENTIAL_VERSION;
		if (
			!lockedUser ||
			!lockedMember ||
			lockedUser.id !== discovered.referenceId ||
			lockedMember.id !== lockedPrincipal.memberId ||
			lockedMember.userId !== lockedUser.id ||
			lockedKey.referenceId !== lockedUser.id ||
			keyCredentialVersion !== userCredentialVersion ||
			!hasCurrentDashboardCredentialPermissions(
				lockedKey.permissions,
				lockedMember.role,
			)
		) {
			return null;
		}
	} else if (
		lockedPrincipal.kind !== "service" ||
		lockedPrincipal.memberId !== null ||
		lockedKey.referenceId !== null
	) {
		return null;
	}

	const principalWorkspaceIds =
		lockedPrincipal.scopeMode === "selected"
			? (
					await database
						.select({ workspaceId: principalWorkspaceGrants.workspaceId })
						.from(principalWorkspaceGrants)
						.where(
							and(
								eq(
									principalWorkspaceGrants.organizationId,
									params.organizationId,
								),
								eq(principalWorkspaceGrants.principalId, lockedPrincipal.id),
							),
						)
						.orderBy(principalWorkspaceGrants.workspaceId)
						.for("share")
				).map((grant) => grant.workspaceId)
			: [];

	let lockedAuthoritySessionExpiresAt: Date | null = null;
	if (params.authoritySessionId !== undefined) {
		if (lockedPrincipal.kind === "member") {
			if (!params.authoritySessionId || !lockedUser) return null;
			const [lockedSession] = await database
				.select({
					id: authSession.id,
					userId: authSession.userId,
					activeOrganizationId: authSession.activeOrganizationId,
					impersonatedBy: authSession.impersonatedBy,
					expiresAt: authSession.expiresAt,
				})
				.from(authSession)
				.where(
					and(
						eq(authSession.id, params.authoritySessionId),
						eq(authSession.userId, lockedUser.id),
						eq(authSession.activeOrganizationId, params.organizationId),
						gt(authSession.expiresAt, sql`statement_timestamp()`),
					),
				)
				.for("share")
				.limit(1);
			if (
				!lockedSession ||
				lockedSession.userId !== lockedUser.id ||
				lockedSession.activeOrganizationId !== params.organizationId ||
				lockedSession.impersonatedBy !== null
			) {
				return null;
			}
			lockedAuthoritySessionExpiresAt = lockedSession.expiresAt;
		} else if (params.authoritySessionId !== null) {
			return null;
		}
	}

	// Take the wall-clock snapshot only after every potentially blocking
	// authority lock, including grants and the exact session. A key or temporary
	// ban must not be evaluated against a timestamp captured before a concurrent
	// revocation transaction released or before the last lock was acquired.
	const now = new Date();
	if (
		(lockedKey.expiresAt !== null && lockedKey.expiresAt <= now) ||
		(lockedPrincipal.kind === "member" &&
			params.authoritySessionId !== undefined &&
			(lockedAuthoritySessionExpiresAt === null ||
				lockedAuthoritySessionExpiresAt <= now)) ||
		(lockedUser?.banned === true &&
			(lockedUser.banExpires === null || lockedUser.banExpires > now))
	) {
		return null;
	}

	const workspaceScope: "all" | string[] =
		lockedPrincipal.scopeMode === "all" ? "all" : principalWorkspaceIds;
	return {
		apiKeyId: lockedKey.id,
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
		authoritySessionId?: string | null;
	},
): Promise<PersistedOperationalScopeValidation> {
	const authorization = await loadLiveApiKeyAuthorization(database, {
		apiKeyId: params.apiKeyId,
		organizationId: params.organizationId,
		authoritySessionId: params.authoritySessionId,
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
