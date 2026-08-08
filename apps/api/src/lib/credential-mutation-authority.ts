import {
	canManageOrganizationCredentials,
	DASHBOARD_SESSION_AUTHORITY_HEADER,
	hasCurrentDashboardCredentialPermissions,
} from "@relayapi/config";
import {
	apikey,
	session as authSession,
	type Database,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization,
	organizationPrincipals,
	principalWorkspaceGrants,
	user,
} from "@relayapi/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Env, Variables } from "../types";

export type CredentialMutationTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

export interface CredentialMutationAuthorityOptions {
	requireAllWorkspaceScope?: boolean;
	requireGlobalAdmin?: boolean;
	requireManageApiKeys?: boolean;
	requireOwner?: boolean;
	requireServiceReferenceNull?: boolean;
	requiredFinancialPermission?: "manage_billing" | "manage_spend";
}

export interface CredentialMutationAuthoritySnapshot {
	organizationId: string;
	keyId: string;
	principalId: string;
	principalType: "dashboard_user" | "service";
	userId: string | null;
	memberId: string | null;
	credentialVersion: string;
	sessionId: string | null;
	memberRole: string | null;
	globalRole: string | null;
	permissions: string[];
	workspaceScope: "all" | string[];
}

/**
 * Minimal revocable authority carried by work that can outlive its admitting
 * HTTP request. Bearer hashes and session tokens are intentionally excluded.
 */
export interface DurableCredentialAuthoritySnapshot {
	organizationId: string;
	keyId: string;
	principalId: string;
	principalType: "dashboard_user" | "service";
	userId: string | null;
	authorityMemberId: string | null;
	credentialVersion: string;
	authoritySessionId: string | null;
	authorityWorkspaceId: string | null;
	authorityRequiresAllWorkspaceScope: boolean;
	admittedAt: Date;
	revision: number;
}

export type CredentialMutationAuthorityResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			status: 401 | 403;
			code: string;
			message: string;
	  };

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

function hasActiveBan(
	value: { banned: boolean | null; banExpires: Date | null },
	now: Date,
): boolean {
	return (
		value.banned === true &&
		(value.banExpires === null || value.banExpires > now)
	);
}

function normalizedPermissions(
	value: string | readonly string[] | null | undefined,
): string[] {
	const permissions: readonly string[] =
		typeof value === "string" ? value.split(",") : (value ?? ["read", "write"]);
	return [
		...new Set(
			permissions.map((permission) => permission.trim()).filter(Boolean),
		),
	].sort();
}

function permissionsMatch(
	stored: string | null | undefined,
	projected: readonly string[],
): boolean {
	return (
		JSON.stringify(normalizedPermissions(stored)) ===
		JSON.stringify(normalizedPermissions(projected))
	);
}

function hasPermission(
	permissions: string | null | undefined,
	permission: string,
): boolean {
	return normalizedPermissions(permissions).includes(permission);
}

function roleIncludesOwner(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.some((candidate) => candidate.trim() === "owner");
}

function roleIncludesGlobalAdmin(role: string | null | undefined): boolean {
	return (role ?? "")
		.split(",")
		.some((candidate) => candidate.trim() === "admin");
}

function scopeMatches(
	liveMode: "all" | "selected",
	liveWorkspaceIds: readonly string[],
	projected: "all" | string[],
): boolean {
	if (liveMode === "all") return projected === "all";
	if (projected === "all") return false;
	const live = [...new Set(liveWorkspaceIds)].sort();
	const cached = [...new Set(projected)].sort();
	return JSON.stringify(live) === JSON.stringify(cached);
}

function unauthorized(): CredentialMutationAuthorityResult<never> {
	return {
		ok: false,
		status: 401,
		code: "CREDENTIAL_NO_LONGER_AUTHORIZED",
		message: "The issuing credential is no longer authorized.",
	};
}

function forbidden(
	code: string,
	message: string,
): CredentialMutationAuthorityResult<never> {
	return { ok: false, status: 403, code, message };
}

/**
 * Revalidate and lock the exact bearer authority inside a caller-owned durable
 * mutation transaction. This variant lets services whose commit boundary is
 * internal (for example automation admission) share the same authority fence
 * without holding credential rows across post-commit provider work.
 */
export async function lockCredentialMutationAuthorityInTransaction(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	options: CredentialMutationAuthorityOptions,
	tx: CredentialMutationTransaction,
): Promise<
	CredentialMutationAuthorityResult<CredentialMutationAuthoritySnapshot>
> {
	const orgId = c.get("orgId");
	const keyId = c.get("keyId");
	const keyHash = c.get("keyHash");
	const principalId = c.get("principalId");
	const projectedPermissions = c.get("permissions");
	const projectedScope = c.get("workspaceScope");

	return (async () => {
		const now = new Date();
		let liveRole: string | null = null;
		let globalRole: string | null = null;
		let liveScopeMode: "all" | "selected";
		let liveCredentialVersion = LEGACY_CREDENTIAL_VERSION;
		let livePermissions: string[] = [];
		let liveUserId: string | null = null;
		let liveMemberId: string | null = null;
		let liveSessionId: string | null = null;
		let liveSessionExpiresAt: Date | null = null;
		let presentedDashboardSessionId: string | null = null;
		let liveKeyExpiresAt: Date | null = null;
		let liveUserBan: {
			banned: boolean | null;
			banExpires: Date | null;
		} | null = null;

		if (c.get("principalType") === "dashboard_user") {
			const principalUserId = c.get("principalUserId");
			const presentedSessionId = c.req.header(
				DASHBOARD_SESSION_AUTHORITY_HEADER,
			);
			if (!principalUserId || !presentedSessionId) return unauthorized();
			presentedDashboardSessionId = presentedSessionId;

			const [lockedUser] = await tx
				.select({
					id: user.id,
					banned: user.banned,
					banExpires: user.banExpires,
					credentialVersion: user.credentialVersion,
					role: user.role,
				})
				.from(user)
				.where(eq(user.id, principalUserId))
				.for("share")
				.limit(1);
			const [lockedMember] = await tx
				.select({ id: member.id, userId: member.userId, role: member.role })
				.from(member)
				.where(
					and(
						eq(member.organizationId, orgId),
						eq(member.userId, principalUserId),
					),
				)
				.for("share")
				.limit(1);
			const [lockedOrganization] = await tx
				.select({
					id: organization.id,
					lifecycleStatus: organization.lifecycleStatus,
				})
				.from(organization)
				.where(eq(organization.id, orgId))
				.for("share")
				.limit(1);
			const [lockedKey] = await tx
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
						eq(apikey.id, keyId),
						eq(apikey.key, keyHash),
						eq(apikey.organizationId, orgId),
						eq(apikey.principalId, principalId),
					),
				)
				.for("share")
				.limit(1);
			const [lockedPrincipal] = await tx
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
						eq(organizationPrincipals.id, principalId),
						eq(organizationPrincipals.organizationId, orgId),
					),
				)
				.for("share")
				.limit(1);

			if (
				!lockedUser ||
				!lockedMember ||
				!lockedOrganization ||
				!lockedKey ||
				!lockedPrincipal ||
				lockedMember.userId !== principalUserId ||
				lockedOrganization.lifecycleStatus !== "active" ||
				lockedKey.referenceId !== principalUserId ||
				lockedKey.principalId !== principalId ||
				lockedKey.enabled !== true ||
				(lockedKey.expiresAt !== null && lockedKey.expiresAt <= now) ||
				!permissionsMatch(lockedKey.permissions, projectedPermissions) ||
				lockedPrincipal.kind !== "member" ||
				lockedPrincipal.memberId !== lockedMember.id ||
				lockedPrincipal.lifecycleStatus !== "active" ||
				hasActiveBan(lockedUser, now) ||
				normalizedCredentialVersion(lockedKey.credentialVersion) !==
					normalizedCredentialVersion(lockedUser.credentialVersion) ||
				!hasCurrentDashboardCredentialPermissions(
					lockedKey.permissions,
					lockedMember.role,
				)
			) {
				return unauthorized();
			}

			liveRole = lockedMember.role;
			globalRole = lockedUser.role;
			liveScopeMode = lockedPrincipal.scopeMode;
			liveCredentialVersion = normalizedCredentialVersion(
				lockedUser.credentialVersion,
			);
			livePermissions = normalizedPermissions(lockedKey.permissions);
			liveUserId = principalUserId;
			liveMemberId = lockedMember.id;
			liveKeyExpiresAt = lockedKey.expiresAt;
			liveUserBan = {
				banned: lockedUser.banned,
				banExpires: lockedUser.banExpires,
			};
		} else {
			const [lockedKey] = await tx
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
						eq(apikey.id, keyId),
						eq(apikey.key, keyHash),
						eq(apikey.organizationId, orgId),
						eq(apikey.principalId, principalId),
					),
				)
				.for("share")
				.limit(1);
			const [lockedPrincipal] = await tx
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
						eq(organizationPrincipals.id, principalId),
						eq(organizationPrincipals.organizationId, orgId),
					),
				)
				.for("share")
				.limit(1);
			const [lockedOrganization] = await tx
				.select({
					id: organization.id,
					lifecycleStatus: organization.lifecycleStatus,
				})
				.from(organization)
				.where(eq(organization.id, orgId))
				.for("share")
				.limit(1);

			if (
				!lockedKey ||
				!lockedPrincipal ||
				!lockedOrganization ||
				lockedKey.principalId !== principalId ||
				lockedKey.enabled !== true ||
				(lockedKey.expiresAt !== null && lockedKey.expiresAt <= now) ||
				!permissionsMatch(lockedKey.permissions, projectedPermissions) ||
				(options.requireServiceReferenceNull &&
					lockedKey.referenceId !== null) ||
				lockedPrincipal.kind !== "service" ||
				lockedPrincipal.memberId !== null ||
				lockedPrincipal.lifecycleStatus !== "active" ||
				lockedOrganization.lifecycleStatus !== "active"
			) {
				return unauthorized();
			}
			liveScopeMode = lockedPrincipal.scopeMode;
			liveCredentialVersion = normalizedCredentialVersion(
				lockedKey.credentialVersion,
			);
			livePermissions = normalizedPermissions(lockedKey.permissions);
			liveKeyExpiresAt = lockedKey.expiresAt;
		}

		const lockedGrants =
			liveScopeMode === "selected"
				? await tx
						.select({ workspaceId: principalWorkspaceGrants.workspaceId })
						.from(principalWorkspaceGrants)
						.where(
							and(
								eq(principalWorkspaceGrants.organizationId, orgId),
								eq(principalWorkspaceGrants.principalId, principalId),
							),
						)
						.orderBy(principalWorkspaceGrants.workspaceId)
						.for("share")
				: [];
		if (
			!scopeMatches(
				liveScopeMode,
				lockedGrants.map((grant) => grant.workspaceId),
				projectedScope,
			)
		) {
			return unauthorized();
		}
		if (c.get("principalType") === "dashboard_user") {
			if (!liveUserId || !presentedDashboardSessionId) return unauthorized();
			const [lockedSession] = await tx
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
						eq(authSession.id, presentedDashboardSessionId),
						eq(authSession.userId, liveUserId),
						eq(authSession.activeOrganizationId, orgId),
						gt(authSession.expiresAt, sql`statement_timestamp()`),
					),
				)
				.for("share")
				.limit(1);
			if (
				!lockedSession ||
				lockedSession.userId !== liveUserId ||
				lockedSession.activeOrganizationId !== orgId ||
				lockedSession.impersonatedBy !== null
			) {
				return unauthorized();
			}
			liveSessionId = lockedSession.id;
			liveSessionExpiresAt = lockedSession.expiresAt;
		}
		// Recheck time-based authority only after every potentially blocking grant
		// and exact-session lock. A request admitted just before key/session expiry
		// must not commit after that expiry merely because `now` was captured early.
		const finalAuthorityTime = new Date();
		if (
			(liveKeyExpiresAt !== null && liveKeyExpiresAt <= finalAuthorityTime) ||
			(c.get("principalType") === "dashboard_user" &&
				(liveSessionExpiresAt === null ||
					liveSessionExpiresAt <= finalAuthorityTime)) ||
			(liveUserBan !== null && hasActiveBan(liveUserBan, finalAuthorityTime))
		) {
			return unauthorized();
		}
		if (options.requireAllWorkspaceScope && liveScopeMode !== "all") {
			return forbidden(
				"ALL_WORKSPACES_REQUIRED",
				"This operation requires an organization-wide credential.",
			);
		}
		if (!hasPermission(projectedPermissions.join(","), "write")) {
			return forbidden(
				"WRITE_PERMISSION_REQUIRED",
				"This operation requires write permission.",
			);
		}
		if (
			options.requireManageApiKeys &&
			!hasPermission(projectedPermissions.join(","), "manage_api_keys")
		) {
			return forbidden(
				"MANAGE_API_KEYS_REQUIRED",
				"The issuing credential can no longer manage organization credentials.",
			);
		}
		if (options.requireManageApiKeys && liveRole !== null) {
			if (!canManageOrganizationCredentials(liveRole)) {
				return forbidden(
					"MANAGE_API_KEYS_REQUIRED",
					"The issuing credential can no longer manage organization credentials.",
				);
			}
		}
		if (options.requireOwner && !roleIncludesOwner(liveRole)) {
			return forbidden(
				"OWNER_SCOPE_GRANT_REQUIRED",
				"Only a current organization owner can delegate elevated or financial scopes.",
			);
		}
		if (options.requireGlobalAdmin && !roleIncludesGlobalAdmin(globalRole)) {
			return forbidden(
				"GLOBAL_ADMIN_REQUIRED",
				"System administrator access is required.",
			);
		}
		if (
			options.requiredFinancialPermission &&
			!hasPermission(
				livePermissions.join(","),
				options.requiredFinancialPermission,
			)
		) {
			return forbidden(
				"FINANCIAL_PERMISSION_REQUIRED",
				`This operation requires ${options.requiredFinancialPermission} permission.`,
			);
		}

		const liveWorkspaceIds = lockedGrants.map((grant) => grant.workspaceId);
		return {
			ok: true,
			value: {
				organizationId: orgId,
				keyId,
				principalId,
				principalType: c.get("principalType"),
				userId: liveUserId,
				memberId: liveMemberId,
				credentialVersion: liveCredentialVersion,
				sessionId: liveSessionId,
				memberRole: liveRole,
				globalRole,
				permissions: livePermissions,
				workspaceScope:
					liveScopeMode === "all" ? "all" : [...liveWorkspaceIds].sort(),
			},
		};
	})();
}

export function createDurableCredentialAuthoritySnapshot(
	authority: CredentialMutationAuthoritySnapshot,
	options?: {
		admittedAt?: Date;
		revision?: number;
		workspaceId?: string | null;
		requireAllWorkspaceScope?: boolean;
	},
): DurableCredentialAuthoritySnapshot {
	const authorityWorkspaceId = options?.workspaceId ?? null;
	const authorityRequiresAllWorkspaceScope =
		authorityWorkspaceId === null || options?.requireAllWorkspaceScope === true;
	if (
		authorityRequiresAllWorkspaceScope &&
		authority.workspaceScope !== "all"
	) {
		throw new Error(
			"Durable organization-scoped authority requires all-workspace scope",
		);
	}
	if (
		authorityWorkspaceId !== null &&
		authority.workspaceScope !== "all" &&
		!authority.workspaceScope.includes(authorityWorkspaceId)
	) {
		throw new Error(
			"Durable authority does not include the operation workspace",
		);
	}
	return {
		organizationId: authority.organizationId,
		keyId: authority.keyId,
		principalId: authority.principalId,
		principalType: authority.principalType,
		userId: authority.userId,
		authorityMemberId: authority.memberId,
		credentialVersion: authority.credentialVersion,
		authoritySessionId: authority.sessionId,
		authorityWorkspaceId,
		authorityRequiresAllWorkspaceScope,
		admittedAt: options?.admittedAt ?? new Date(),
		revision: options?.revision ?? 1,
	};
}

/**
 * Revalidate stored asynchronous authority without reconstructing request
 * context or retaining bearer/session secrets. Revocation-relevant rows remain
 * locked through the caller-owned transaction.
 */
export async function lockDurableCredentialAuthorityInTransaction(
	tx: CredentialMutationTransaction,
	snapshot: DurableCredentialAuthoritySnapshot,
	options: {
		requiredFinancialPermission?: "manage_billing" | "manage_spend";
	} = {},
): Promise<
	CredentialMutationAuthorityResult<DurableCredentialAuthoritySnapshot>
> {
	const [discoveredKey] = await tx
		.select({
			referenceId: apikey.referenceId,
			principalId: apikey.principalId,
		})
		.from(apikey)
		.where(
			and(
				eq(apikey.id, snapshot.keyId),
				eq(apikey.organizationId, snapshot.organizationId),
			),
		)
		.limit(1);
	const [discoveredPrincipal] = await tx
		.select({
			kind: organizationPrincipals.kind,
			memberId: organizationPrincipals.memberId,
		})
		.from(organizationPrincipals)
		.where(
			and(
				eq(organizationPrincipals.id, snapshot.principalId),
				eq(organizationPrincipals.organizationId, snapshot.organizationId),
			),
		)
		.limit(1);
	if (
		!discoveredKey ||
		!discoveredPrincipal ||
		discoveredKey.principalId !== snapshot.principalId
	) {
		return unauthorized();
	}

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
	if (snapshot.principalType === "dashboard_user") {
		if (
			!snapshot.userId ||
			!snapshot.authorityMemberId ||
			discoveredPrincipal.memberId !== snapshot.authorityMemberId
		)
			return unauthorized();
		[lockedUser] = await tx
			.select({
				id: user.id,
				banned: user.banned,
				banExpires: user.banExpires,
				credentialVersion: user.credentialVersion,
			})
			.from(user)
			.where(eq(user.id, snapshot.userId))
			.for("share")
			.limit(1);
		[lockedMember] = await tx
			.select({
				id: member.id,
				role: member.role,
				userId: member.userId,
				organizationId: member.organizationId,
			})
			.from(member)
			.where(
				and(
					eq(member.id, snapshot.authorityMemberId),
					eq(member.organizationId, snapshot.organizationId),
					eq(member.userId, snapshot.userId),
				),
			)
			.for("share")
			.limit(1);
	}

	const [lockedOrganization] = await tx
		.select({
			id: organization.id,
			lifecycleStatus: organization.lifecycleStatus,
		})
		.from(organization)
		.where(eq(organization.id, snapshot.organizationId))
		.for("share")
		.limit(1);
	const [lockedKey] = await tx
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
				eq(apikey.id, snapshot.keyId),
				eq(apikey.organizationId, snapshot.organizationId),
				eq(apikey.principalId, snapshot.principalId),
			),
		)
		.for("share")
		.limit(1);
	const [lockedPrincipal] = await tx
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
				eq(organizationPrincipals.id, snapshot.principalId),
				eq(organizationPrincipals.organizationId, snapshot.organizationId),
			),
		)
		.for("share")
		.limit(1);
	const lockedGrants =
		lockedPrincipal?.scopeMode === "selected"
			? await tx
					.select({ workspaceId: principalWorkspaceGrants.workspaceId })
					.from(principalWorkspaceGrants)
					.where(
						and(
							eq(
								principalWorkspaceGrants.organizationId,
								snapshot.organizationId,
							),
							eq(principalWorkspaceGrants.principalId, snapshot.principalId),
						),
					)
					.orderBy(principalWorkspaceGrants.workspaceId)
					.for("share")
			: [];

	let lockedAuthoritySession:
		| {
				id: string;
				userId: string;
				activeOrganizationId: string | null;
				impersonatedBy: string | null;
				expiresAt: Date;
		  }
		| undefined;
	if (
		snapshot.principalType === "dashboard_user" &&
		snapshot.userId &&
		snapshot.authoritySessionId
	) {
		[lockedAuthoritySession] = await tx
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
					eq(authSession.id, snapshot.authoritySessionId),
					eq(authSession.userId, snapshot.userId),
					eq(authSession.activeOrganizationId, snapshot.organizationId),
					gt(authSession.expiresAt, sql`statement_timestamp()`),
				),
			)
			.for("share")
			.limit(1);
	}

	const now = new Date();
	if (
		lockedOrganization?.lifecycleStatus !== "active" ||
		!lockedKey ||
		lockedKey.enabled !== true ||
		(lockedKey.expiresAt !== null && lockedKey.expiresAt <= now) ||
		!lockedPrincipal ||
		lockedPrincipal.lifecycleStatus !== "active" ||
		lockedPrincipal.kind !==
			(snapshot.principalType === "dashboard_user" ? "member" : "service") ||
		(snapshot.authorityWorkspaceId === null &&
			!snapshot.authorityRequiresAllWorkspaceScope) ||
		((snapshot.authorityRequiresAllWorkspaceScope ||
			snapshot.authorityWorkspaceId === null) &&
			lockedPrincipal.scopeMode !== "all") ||
		(snapshot.authorityWorkspaceId !== null &&
			lockedPrincipal.scopeMode !== "all" &&
			!lockedGrants.some(
				(grant) => grant.workspaceId === snapshot.authorityWorkspaceId,
			)) ||
		(options.requiredFinancialPermission &&
			!hasPermission(
				lockedKey.permissions,
				options.requiredFinancialPermission,
			))
	) {
		return unauthorized();
	}

	if (snapshot.principalType === "dashboard_user") {
		if (
			!lockedUser ||
			!lockedMember ||
			lockedMember.id !== snapshot.authorityMemberId ||
			lockedPrincipal.memberId !== lockedMember.id ||
			lockedKey.referenceId !== snapshot.userId ||
			hasActiveBan(lockedUser, now) ||
			!hasCurrentDashboardCredentialPermissions(
				lockedKey.permissions,
				lockedMember.role,
			) ||
			normalizedCredentialVersion(lockedUser.credentialVersion) !==
				snapshot.credentialVersion ||
			normalizedCredentialVersion(lockedKey.credentialVersion) !==
				snapshot.credentialVersion ||
			!snapshot.authoritySessionId ||
			!lockedAuthoritySession ||
			lockedAuthoritySession.id !== snapshot.authoritySessionId ||
			lockedAuthoritySession.userId !== snapshot.userId ||
			lockedAuthoritySession.activeOrganizationId !== snapshot.organizationId ||
			lockedAuthoritySession.impersonatedBy !== null ||
			lockedAuthoritySession.expiresAt <= now
		) {
			return unauthorized();
		}
	} else if (
		snapshot.userId !== null ||
		snapshot.authorityMemberId !== null ||
		snapshot.authoritySessionId !== null ||
		lockedPrincipal.memberId !== null ||
		lockedKey.referenceId !== null ||
		normalizedCredentialVersion(lockedKey.credentialVersion) !==
			snapshot.credentialVersion
	) {
		return unauthorized();
	}

	return { ok: true, value: snapshot };
}

export async function withCredentialMutationAuthorityInTransaction<T>(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	options: CredentialMutationAuthorityOptions,
	tx: CredentialMutationTransaction,
	operation: (
		tx: CredentialMutationTransaction,
		authority: CredentialMutationAuthoritySnapshot,
	) => Promise<T>,
): Promise<CredentialMutationAuthorityResult<T>> {
	const authority = await lockCredentialMutationAuthorityInTransaction(
		c,
		options,
		tx,
	);
	if (!authority.ok) return authority;
	return { ok: true, value: await operation(tx, authority.value) };
}

/**
 * Revalidate and lock the exact bearer authority at the durable mutation
 * boundary. Every revocation-relevant row remains locked until `operation`
 * commits, so revoke-first rejects and mutation-first makes revocation wait.
 */
export async function withCredentialMutationAuthority<T>(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	options: CredentialMutationAuthorityOptions,
	operation: (
		tx: CredentialMutationTransaction,
		authority: CredentialMutationAuthoritySnapshot,
	) => Promise<T>,
): Promise<CredentialMutationAuthorityResult<T>> {
	return c
		.get("db")
		.transaction((tx) =>
			withCredentialMutationAuthorityInTransaction(c, options, tx, operation),
		);
}
