import { getCurrentAdapter } from "@better-auth/core/context";
import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";
import { APIError, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { isActiveUserBan } from "./admin-ban-endpoints";
import type { TransactionalEndpointContext } from "./atomic-endpoint";
import { roles } from "./permissions";

export type OrganizationActorOperation = "invite" | "update-member-role";

type AuthoritativeSession = Awaited<
	ReturnType<typeof getAuthoritativeSessionFromCtx>
>;
type AuthoritativeSessionResolver = (
	context: Parameters<typeof getAuthoritativeSessionFromCtx>[0],
) => Promise<AuthoritativeSession>;

export type OrganizationActorMutationContext = TransactionalEndpointContext & {
	body?: {
		memberId?: unknown;
		organizationId?: unknown;
	};
	context: TransactionalEndpointContext["context"] & {
		session?: {
			session: {
				activeOrganizationId?: unknown;
				id?: unknown;
				token?: unknown;
				userId?: unknown;
			};
			user: {
				credentialVersion?: unknown;
				id?: unknown;
			};
		} | null;
	};
};

type MemberRecord = {
	createdAt?: unknown;
	id?: unknown;
	organizationId?: unknown;
	role?: unknown;
	userId?: unknown;
};

function organizationError(
	operation: OrganizationActorOperation,
	kind: "missing-active" | "not-found",
): APIError {
	if (kind === "missing-active" && operation === "update-member-role") {
		return APIError.from("BAD_REQUEST", {
			code: "NO_ACTIVE_ORGANIZATION",
			message: "No active organization",
		});
	}
	return APIError.from("BAD_REQUEST", {
		code: "ORGANIZATION_NOT_FOUND",
		message: "Organization not found",
	});
}

function memberNotFoundError(): APIError {
	return APIError.from("BAD_REQUEST", {
		code: "MEMBER_NOT_FOUND",
		message: "Member not found",
	});
}

function actorLacksAuthorityError(
	operation: OrganizationActorOperation,
): APIError {
	return APIError.from("FORBIDDEN", {
		code:
			operation === "invite"
				? "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION"
				: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER",
		message:
			operation === "invite"
				? "You are not allowed to invite users to this organization"
				: "You are not allowed to update this member",
	});
}

function canPerformOrganizationMutation(
	role: string,
	operation: OrganizationActorOperation,
): boolean {
	const permission =
		operation === "invite"
			? { invitation: ["create"] as const }
			: { member: ["update"] as const };
	return role
		.split(",")
		.map((candidate) => candidate.trim())
		.filter(Boolean)
		.some((candidate) => {
			const configuredRole = roles[candidate as keyof typeof roles];
			return configuredRole?.authorize(permission).success === true;
		});
}

function requireAuthenticatedActor(
	authSession: OrganizationActorMutationContext["context"]["session"],
) {
	const userId = authSession?.user.id;
	const sessionId = authSession?.session.id;
	const sessionToken = authSession?.session.token;
	if (
		!authSession ||
		typeof userId !== "string" ||
		typeof sessionId !== "string" ||
		typeof sessionToken !== "string"
	) {
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}
	return { authSession, sessionId, sessionToken, userId };
}

/**
 * Linearize a Better Auth organization authority decision with the mutation it
 * authorizes. The endpoint wrapper supplies the transaction; these no-op
 * updates acquire PostgreSQL row locks through Better Auth's adapter.
 *
 * The member rows are locked by ID in a stable order before the organization
 * row, matching RelayAPI's member -> organization invariant. Including the
 * target member for role changes prevents two administrators from deadlocking
 * while promoting or demoting one another.
 */
export async function fenceOrganizationMutationActor(
	context: OrganizationActorMutationContext,
	operation: OrganizationActorOperation,
	resolveAuthoritativeSession: AuthoritativeSessionResolver = getAuthoritativeSessionFromCtx,
): Promise<void> {
	// This call deliberately occurs inside wrapEndpointInTransaction. Stateful
	// Better Auth deployments clear any signed-cookie projection and resolve the
	// server-side row through the transaction adapter before we extract identity.
	const authoritativeSession = await resolveAuthoritativeSession(
		context as Parameters<typeof getAuthoritativeSessionFromCtx>[0],
	);
	context.context.session =
		authoritativeSession as OrganizationActorMutationContext["context"]["session"];
	const { authSession, sessionId, sessionToken, userId } =
		requireAuthenticatedActor(authoritativeSession);
	const explicitOrganizationId = context.body?.organizationId;
	const activeOrganizationId = authSession.session.activeOrganizationId;
	const organizationId =
		typeof explicitOrganizationId === "string"
			? explicitOrganizationId
			: typeof activeOrganizationId === "string"
				? activeOrganizationId
				: undefined;
	if (!organizationId) {
		throw organizationError(operation, "missing-active");
	}

	const expectedCredentialVersion =
		typeof authSession.user.credentialVersion === "string" &&
		authSession.user.credentialVersion
			? authSession.user.credentialVersion
			: LEGACY_CREDENTIAL_VERSION;
	const transactionAdapter = await getCurrentAdapter(context.context.adapter);

	// User first: ban and identity deletion paths acquire this same row before
	// touching memberships or sessions. The generation predicate fails closed if
	// a ban committed while the request body was still being consumed.
	const lockedUser = await transactionAdapter.update<{
		banExpires?: Date | string | null;
		banned?: boolean | null;
		credentialVersion?: unknown;
		id?: unknown;
	}>({
		model: "user",
		where: [
			{ field: "id", value: userId },
			{ field: "credentialVersion", value: expectedCredentialVersion },
		],
		update: { credentialVersion: expectedCredentialVersion },
	});
	if (
		!lockedUser ||
		lockedUser.id !== userId ||
		lockedUser.credentialVersion !== expectedCredentialVersion ||
		isActiveUserBan({
			banned: lockedUser.banned ?? null,
			banExpires: lockedUser.banExpires ?? null,
		})
	) {
		throw APIError.from("UNAUTHORIZED", {
			code: "SESSION_CREDENTIAL_STALE",
			message: "The authenticated session is no longer current.",
		});
	}

	// These reads discover the stable IDs to lock. Every decision is deferred
	// until after the exact session and all discovered authoritative rows have
	// been locked and re-read through UPDATE ... RETURNING.
	const discoveredActor = await transactionAdapter.findOne<MemberRecord>({
		model: "member",
		where: [
			{ field: "userId", value: userId },
			{ field: "organizationId", value: organizationId },
		],
	});
	const requestedTargetId =
		operation === "update-member-role" &&
		typeof context.body?.memberId === "string"
			? context.body.memberId
			: undefined;
	const discoveredTarget = requestedTargetId
		? await transactionAdapter.findOne<MemberRecord>({
				model: "member",
				where: [{ field: "id", value: requestedTargetId }],
			})
		: null;

	const lockableMembers = new Map<string, MemberRecord>();
	if (typeof discoveredActor?.id === "string") {
		lockableMembers.set(discoveredActor.id, discoveredActor);
	}
	if (
		typeof discoveredTarget?.id === "string" &&
		discoveredTarget.organizationId === organizationId
	) {
		lockableMembers.set(discoveredTarget.id, discoveredTarget);
	}
	const lockedMembers = new Map<string, MemberRecord>();
	for (const memberId of [...lockableMembers.keys()].sort()) {
		const lockedMember = await transactionAdapter.update<MemberRecord>({
			model: "member",
			where: [
				{ field: "id", value: memberId },
				{ field: "organizationId", value: organizationId },
			],
			// Updating only the immutable identifier acquires the tuple lock without
			// firing RelayAPI's role/organization authority-change triggers.
			update: { id: memberId },
		});
		if (lockedMember) lockedMembers.set(memberId, lockedMember);
	}

	const lockedOrganization = await transactionAdapter.update<{
		id?: unknown;
		lifecycleStatus?: unknown;
	}>({
		model: "organization",
		where: [{ field: "id", value: organizationId }],
		update: { id: organizationId },
	});

	// Session last matches the established user -> member -> organization ->
	// session order used by atomic identity deletion. A concurrent exact-session
	// deletion either commits first and is observed here, or waits for this
	// authority-bearing transaction to finish.
	const lockedSession = await transactionAdapter.update<{ id?: unknown }>({
		model: "session",
		where: [
			{ field: "id", value: sessionId },
			{ field: "token", value: sessionToken },
			{ field: "userId", value: userId },
			{ field: "expiresAt", operator: "gt", value: new Date() },
		],
		update: { updatedAt: new Date() },
	});
	if (!lockedSession || lockedSession.id !== sessionId) {
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}

	if (
		!lockedOrganization ||
		lockedOrganization.id !== organizationId ||
		lockedOrganization.lifecycleStatus !== "active"
	) {
		throw organizationError(operation, "not-found");
	}
	const actorId = discoveredActor?.id;
	const lockedActor =
		typeof actorId === "string" ? lockedMembers.get(actorId) : undefined;
	if (
		!lockedActor ||
		lockedActor.id !== actorId ||
		lockedActor.userId !== userId ||
		lockedActor.organizationId !== organizationId ||
		typeof lockedActor.role !== "string"
	) {
		throw memberNotFoundError();
	}
	if (!canPerformOrganizationMutation(lockedActor.role, operation)) {
		throw actorLacksAuthorityError(operation);
	}

	if (operation === "update-member-role") {
		if (!requestedTargetId || !discoveredTarget) {
			throw memberNotFoundError();
		}
		if (discoveredTarget.organizationId !== organizationId) {
			throw APIError.from("FORBIDDEN", {
				code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER",
				message: "You are not allowed to update this member",
			});
		}
		const lockedTarget = lockedMembers.get(requestedTargetId);
		if (
			!lockedTarget ||
			lockedTarget.id !== requestedTargetId ||
			lockedTarget.organizationId !== organizationId
		) {
			throw memberNotFoundError();
		}
	}
}
