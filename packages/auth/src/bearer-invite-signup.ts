import { getCurrentAdapter } from "@better-auth/core/context";
import type { DBTransactionAdapter } from "@better-auth/core/db/adapter";
import { hasOrganizationRole } from "@relayapi/config";
import {
	inviteSignupClaimForUser,
	LEGACY_CREDENTIAL_VERSION,
} from "@relayapi/db";
import type { BetterAuthPlugin } from "better-auth";
import {
	BEARER_INVITE_SIGNUP_HEADER,
	isBearerInviteToken,
} from "./bearer-invite-contract";

type BearerInviteRole = "owner" | "admin" | "member";

export interface BearerInviteSignupCandidate {
	createdBy: string;
	expiresAt: Date;
	issuerBanExpires: Date | null;
	issuerBanned: boolean | null;
	issuerCredentialVersion: string | null;
	issuerLiveCredentialVersion: string | null;
	issuerLiveUserId: string;
	issuerPrincipalStatus: string;
	issuerRole: string;
	issuerUserId: string;
	organizationStatus: string;
	role: BearerInviteRole;
	usedAt: Date | null;
	workspaceScopeValid: boolean;
}

type AuthHookContext = {
	context?: { adapter?: Parameters<typeof getCurrentAdapter>[0] };
	headers?: { get(name: string): string | null };
	path?: string;
	request?: { headers?: { get(name: string): string | null } };
};

function normalizedCredentialVersion(value: string | null | undefined): string {
	return value || LEGACY_CREDENTIAL_VERSION;
}

function issuerCanGrantRole(
	issuerRoles: string,
	requestedRole: BearerInviteRole,
): boolean {
	if (hasOrganizationRole(issuerRoles, "owner")) return true;
	if (requestedRole === "owner") return false;
	if (hasOrganizationRole(issuerRoles, "admin")) return true;
	return (
		requestedRole === "member" && hasOrganizationRole(issuerRoles, "member")
	);
}

export function bearerInviteTokenFromSignUpContext(
	context: unknown,
): string | null {
	const authContext = context as AuthHookContext | null | undefined;
	if (authContext?.path !== "/sign-up/email") return null;
	const headers = authContext.request?.headers ?? authContext.headers;
	const token = headers?.get(BEARER_INVITE_SIGNUP_HEADER);
	return isBearerInviteToken(token) ? token : null;
}

export function isLiveBearerInviteSignupCandidate(
	candidate: BearerInviteSignupCandidate | null | undefined,
	now = new Date(),
): boolean {
	if (
		!candidate ||
		candidate.usedAt ||
		candidate.expiresAt <= now ||
		!candidate.workspaceScopeValid
	)
		return false;
	if (
		candidate.organizationStatus !== "active" ||
		candidate.issuerPrincipalStatus !== "active" ||
		candidate.issuerUserId !== candidate.createdBy ||
		candidate.issuerLiveUserId !== candidate.createdBy
	) {
		return false;
	}
	const issuerIsActivelyBanned =
		candidate.issuerBanned === true &&
		(candidate.issuerBanExpires === null || candidate.issuerBanExpires > now);
	if (
		issuerIsActivelyBanned ||
		normalizedCredentialVersion(candidate.issuerCredentialVersion) !==
			normalizedCredentialVersion(candidate.issuerLiveCredentialVersion)
	) {
		return false;
	}
	return issuerCanGrantRole(candidate.issuerRole, candidate.role);
}

export async function hashBearerInviteToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export const bearerInviteSignupClaimPlugin: BetterAuthPlugin = {
	id: "bearer-invite-signup-claim",
	schema: {
		bearerInviteSignupClaim: {
			modelName: "inviteTokens",
			disableMigration: true,
			fields: {
				organizationId: { type: "string", required: true },
				createdBy: { type: "string", required: true },
				createdByPrincipalId: { type: "string", required: true },
				issuerCredentialVersion: { type: "string", required: true },
				tokenHash: { type: "string", required: true, unique: true },
				scopeMode: { type: "string", required: true },
				role: { type: "string", required: true },
				usedAt: { type: "date", required: false },
				usedBy: { type: "string", required: false },
				redeemedByUserId: { type: "string", required: false },
				expiresAt: { type: "date", required: true },
			},
		},
		bearerInviteIssuerPrincipal: {
			modelName: "organizationPrincipals",
			disableMigration: true,
			fields: {
				organizationId: { type: "string", required: true },
				kind: { type: "string", required: true },
				memberId: { type: "string", required: false },
				scopeMode: { type: "string", required: true },
				lifecycleStatus: { type: "string", required: true },
			},
		},
		bearerInviteWorkspaceEvidence: {
			modelName: "inviteTokenWorkspaces",
			disableMigration: true,
			fields: {
				organizationId: { type: "string", required: true },
				inviteTokenId: { type: "string", required: true },
				workspaceId: { type: "string", required: true },
				scopeMode: { type: "string", required: true },
			},
		},
		bearerInviteWorkspace: {
			modelName: "workspaces",
			disableMigration: true,
			fields: {
				organizationId: { type: "string", required: true },
				lifecycleStatus: { type: "string", required: true },
				revision: { type: "number", required: true },
			},
		},
	},
};

type BearerInviteTransactionAdapter = Pick<
	DBTransactionAdapter,
	"findMany" | "findOne" | "update"
>;

interface BearerInviteTokenRow {
	id?: unknown;
	organizationId?: unknown;
	createdBy?: unknown;
	createdByPrincipalId?: unknown;
	issuerCredentialVersion?: unknown;
	tokenHash?: unknown;
	scopeMode?: unknown;
	role?: unknown;
	usedAt?: unknown;
	usedBy?: unknown;
	redeemedByUserId?: unknown;
	expiresAt?: unknown;
}

interface BearerInvitePrincipalRow {
	id?: unknown;
	organizationId?: unknown;
	kind?: unknown;
	memberId?: unknown;
	lifecycleStatus?: unknown;
}

interface BearerInviteMemberRow {
	id?: unknown;
	organizationId?: unknown;
	role?: unknown;
	userId?: unknown;
}

interface BearerInviteUserRow {
	id?: unknown;
	banned?: boolean | null;
	banExpires?: Date | string | null;
	credentialVersion?: unknown;
}

interface BearerInviteOrganizationRow {
	id?: unknown;
	lifecycleStatus?: unknown;
}

interface BearerInviteWorkspaceEvidenceRow {
	organizationId?: unknown;
	inviteTokenId?: unknown;
	workspaceId?: unknown;
	scopeMode?: unknown;
}

interface BearerInviteWorkspaceRow {
	id?: unknown;
	organizationId?: unknown;
	lifecycleStatus?: unknown;
}

function dateValue(value: unknown): Date | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	if (typeof value !== "string") return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isBearerInviteRole(value: unknown): value is BearerInviteRole {
	return value === "owner" || value === "admin" || value === "member";
}

/**
 * Lock and revalidate every row that authorizes bearer-invite signup, then
 * claim the token. The caller must supply Better Auth's current signup
 * transaction adapter so the claim rolls back if later user/account creation
 * fails.
 */
export async function claimBearerInviteForSignUpWithAdapter(
	adapter: BearerInviteTransactionAdapter,
	tokenHash: string,
	userId: string,
	now = new Date(),
): Promise<boolean> {
	if (!tokenHash || !userId) return false;

	// Discover stable row IDs inside the signup transaction. No authority
	// decision is made until each discovered row has been locked and re-read.
	const token = await adapter.findOne<BearerInviteTokenRow>({
		model: "bearerInviteSignupClaim",
		where: [{ field: "tokenHash", value: tokenHash }],
	});
	const tokenId = token?.id;
	const organizationId = token?.organizationId;
	const issuerUserId = token?.createdBy;
	const issuerPrincipalId = token?.createdByPrincipalId;
	const expiresAt = dateValue(token?.expiresAt);
	if (
		typeof tokenId !== "string" ||
		typeof organizationId !== "string" ||
		typeof issuerUserId !== "string" ||
		typeof issuerPrincipalId !== "string" ||
		!isBearerInviteRole(token?.role) ||
		(token?.scopeMode !== "all" && token?.scopeMode !== "selected") ||
		!expiresAt ||
		expiresAt <= now ||
		token.usedAt != null ||
		token.usedBy != null ||
		token.redeemedByUserId != null
	) {
		return false;
	}
	const expectedCredentialVersion = normalizedCredentialVersion(
		typeof token.issuerCredentialVersion === "string"
			? token.issuerCredentialVersion
			: null,
	);

	const principal = await adapter.findOne<BearerInvitePrincipalRow>({
		model: "bearerInviteIssuerPrincipal",
		where: [
			{ field: "id", value: issuerPrincipalId },
			{ field: "organizationId", value: organizationId },
		],
	});
	if (typeof principal?.memberId !== "string") return false;
	const issuerMemberId = principal.memberId;

	const discoveredMember = await adapter.findOne<BearerInviteMemberRow>({
		model: "member",
		where: [
			{ field: "id", value: issuerMemberId },
			{ field: "organizationId", value: organizationId },
		],
	});
	if (!discoveredMember) return false;

	const workspaceEvidence =
		token.scopeMode === "selected"
			? await adapter.findMany<BearerInviteWorkspaceEvidenceRow>({
					model: "bearerInviteWorkspaceEvidence",
					where: [
						{ field: "organizationId", value: organizationId },
						{ field: "inviteTokenId", value: tokenId },
					],
					limit: 100,
				})
			: [];
	const workspaceIds = workspaceEvidence
		.map((row) => row.workspaceId)
		.filter(
			(workspaceId): workspaceId is string => typeof workspaceId === "string",
		);
	if (
		token.scopeMode === "selected" &&
		(workspaceIds.length === 0 ||
			workspaceIds.length !== workspaceEvidence.length)
	) {
		return false;
	}

	// Match the established user -> member -> organization authority lock order.
	// Ban/generation changes take the user first; role removal takes the member;
	// tenant suspension takes the organization. Whichever transaction wins its
	// first lock is observed before this signup can claim the token.
	const lockedUser = await adapter.update<BearerInviteUserRow>({
		model: "user",
		where: [
			{ field: "id", value: issuerUserId },
			{ field: "credentialVersion", value: expectedCredentialVersion },
		],
		update: { credentialVersion: expectedCredentialVersion },
	});
	if (!lockedUser) return false;

	const lockedMember = await adapter.update<BearerInviteMemberRow>({
		model: "member",
		where: [
			{ field: "id", value: issuerMemberId },
			{ field: "organizationId", value: organizationId },
		],
		update: { id: issuerMemberId },
	});
	if (!lockedMember) return false;

	const lockedOrganization = await adapter.update<BearerInviteOrganizationRow>({
		model: "organization",
		where: [{ field: "id", value: organizationId }],
		update: { id: organizationId },
	});
	if (!lockedOrganization) return false;

	const lockedPrincipal = await adapter.update<BearerInvitePrincipalRow>({
		model: "bearerInviteIssuerPrincipal",
		where: [
			{ field: "id", value: issuerPrincipalId },
			{ field: "organizationId", value: organizationId },
		],
		update: { id: issuerPrincipalId },
	});
	if (!lockedPrincipal) return false;

	let workspaceScopeValid = token.scopeMode === "all";
	if (token.scopeMode === "selected") {
		workspaceScopeValid = true;
		for (const workspaceId of [...new Set(workspaceIds)].sort()) {
			const lockedWorkspace: BearerInviteWorkspaceRow | null =
				await adapter.update<BearerInviteWorkspaceRow>({
					model: "bearerInviteWorkspace",
					where: [
						{ field: "id", value: workspaceId },
						{ field: "organizationId", value: organizationId },
					],
					update: { id: workspaceId },
				});
			if (
				!lockedWorkspace ||
				lockedWorkspace.id !== workspaceId ||
				lockedWorkspace.organizationId !== organizationId ||
				lockedWorkspace.lifecycleStatus !== "active"
			) {
				workspaceScopeValid = false;
				break;
			}
		}
	}

	if (
		!isLiveBearerInviteSignupCandidate(
			{
				createdBy: issuerUserId,
				expiresAt,
				issuerBanExpires: dateValue(lockedUser.banExpires),
				issuerBanned: lockedUser.banned ?? null,
				issuerCredentialVersion: expectedCredentialVersion,
				issuerLiveCredentialVersion:
					typeof lockedUser.credentialVersion === "string"
						? lockedUser.credentialVersion
						: null,
				issuerLiveUserId:
					typeof lockedUser.id === "string" ? lockedUser.id : "",
				issuerPrincipalStatus:
					typeof lockedPrincipal.lifecycleStatus === "string"
						? lockedPrincipal.lifecycleStatus
						: "",
				issuerRole:
					typeof lockedMember.role === "string" ? lockedMember.role : "",
				issuerUserId:
					typeof lockedMember.userId === "string" ? lockedMember.userId : "",
				organizationStatus:
					typeof lockedOrganization.lifecycleStatus === "string"
						? lockedOrganization.lifecycleStatus
						: "",
				role: token.role,
				usedAt: null,
				workspaceScopeValid:
					workspaceScopeValid &&
					lockedPrincipal.id === issuerPrincipalId &&
					lockedPrincipal.organizationId === organizationId &&
					lockedPrincipal.kind === "member" &&
					lockedPrincipal.memberId === issuerMemberId &&
					lockedMember.id === issuerMemberId &&
					lockedMember.organizationId === organizationId &&
					lockedOrganization.id === organizationId,
			},
			now,
		)
	) {
		return false;
	}

	const claim = inviteSignupClaimForUser(userId);
	const claimed = await adapter.update<BearerInviteTokenRow>({
		model: "bearerInviteSignupClaim",
		where: [
			{ field: "id", value: tokenId },
			{ field: "tokenHash", value: tokenHash },
			{ field: "organizationId", value: organizationId },
			{ field: "createdBy", value: issuerUserId },
			{ field: "createdByPrincipalId", value: issuerPrincipalId },
			{ field: "issuerCredentialVersion", value: expectedCredentialVersion },
			{ field: "scopeMode", value: token.scopeMode },
			{ field: "role", value: token.role },
			{ field: "usedAt", value: null },
			{ field: "usedBy", value: null },
			{ field: "redeemedByUserId", value: null },
			{ field: "expiresAt", value: now, operator: "gt" },
		],
		update: { usedAt: now, usedBy: claim },
	});
	return (
		claimed?.id === tokenId &&
		claimed.usedBy === claim &&
		dateValue(claimed.usedAt)?.getTime() === now.getTime()
	);
}

/**
 * Claims a bearer invitation inside Better Auth's signup transaction. A thrown
 * signup error rolls this update back; a committed account owns the sole claim.
 */
export async function claimLiveBearerInviteForSignUp(
	token: string,
	userId: string,
	context: unknown,
	now = new Date(),
): Promise<boolean> {
	const authContext = context as AuthHookContext | null | undefined;
	const fallbackAdapter = authContext?.context?.adapter;
	if (!fallbackAdapter) return false;
	const adapter = await getCurrentAdapter(fallbackAdapter);
	const tokenHash = await hashBearerInviteToken(token);
	return claimBearerInviteForSignUpWithAdapter(adapter, tokenHash, userId, now);
}
