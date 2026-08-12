import { getCurrentAdapter } from "@better-auth/core/context";
import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";
import { APIError, getAuthoritativeSessionFromCtx } from "better-auth/api";
import {
	type TransactionalEndpointContext,
	wrapEndpointInTransaction,
} from "./atomic-endpoint";

type AdminUserMutationContext = TransactionalEndpointContext & {
	body?: {
		userId?: unknown;
		data?: Record<string, unknown>;
		banExpiresIn?: unknown;
	};
	context: TransactionalEndpointContext["context"] & {
		internalAdapter?: {
			findUserById(userId: string): Promise<{
				banned?: boolean | null;
				banExpires?: Date | string | null;
			} | null>;
			deleteUserSessions(userId: string): Promise<unknown>;
			updateUser(
				userId: string,
				data: Record<string, unknown>,
			): Promise<unknown>;
		};
	};
};

type AdminUserMutationEndpoint = ((
	context: AdminUserMutationContext,
) => Promise<unknown>) & {
	path?: unknown;
	method?: unknown;
	options?: unknown;
	headers?: unknown;
};

type AdminPluginWithMutableEndpoints = {
	endpoints?: {
		[key: string]: unknown;
		adminUpdateUser?: unknown;
		banUser?: unknown;
	};
};

export const FENCED_ADMIN_MUTATION_ENDPOINTS = [
	"setRole",
	"createUser",
	"adminUpdateUser",
	"unbanUser",
	"banUser",
	"impersonateUser",
	"revokeUserSession",
	"revokeUserSessions",
	"removeUser",
	"setUserPassword",
] as const;

/**
 * Safe de-escalation only: an impersonated session must be able to terminate
 * itself, and cannot pass the real-administrator fence by design.
 */
export const ADMIN_MUTATION_AUTHORITY_EXEMPTIONS = [
	"stopImpersonating",
] as const;

/** RelayAPI deliberately forbids Better Auth's sessionless createUser mode. */
export const ADMIN_MUTATIONS_REQUIRE_AUTHENTICATED_SESSION = true;

export type FencedAdminMutationEndpoint =
	(typeof FENCED_ADMIN_MUTATION_ENDPOINTS)[number];

type GlobalAdminMutationContext = AdminUserMutationContext & {
	context: AdminUserMutationContext["context"] & {
		session?: {
			session: {
				id?: unknown;
				impersonatedBy?: unknown;
				token?: unknown;
				userId?: unknown;
			};
			user: {
				credentialVersion?: unknown;
				id?: unknown;
				role?: unknown;
			};
		} | null;
	};
};

type AuthoritativeAdminSession = Awaited<
	ReturnType<typeof getAuthoritativeSessionFromCtx>
>;

function hasGlobalAdminRole(role: unknown): boolean {
	const values = Array.isArray(role)
		? role.filter((value): value is string => typeof value === "string")
		: typeof role === "string"
			? role.split(",")
			: [];
	return values.some((value) => value.trim() === "admin");
}

/** Lock the exact administrator identity and session through mutation commit. */
export async function fenceGlobalAdminMutationActor(
	context: GlobalAdminMutationContext,
	resolveAuthoritativeSession: (
		context: Parameters<typeof getAuthoritativeSessionFromCtx>[0],
	) => Promise<AuthoritativeAdminSession> = getAuthoritativeSessionFromCtx,
): Promise<void> {
	const authoritativeSession = await resolveAuthoritativeSession(
		context as Parameters<typeof getAuthoritativeSessionFromCtx>[0],
	);
	context.context.session =
		authoritativeSession as GlobalAdminMutationContext["context"]["session"];
	const userId = authoritativeSession?.user.id;
	const sessionId = authoritativeSession?.session.id;
	const sessionToken = authoritativeSession?.session.token;
	if (
		!authoritativeSession ||
		typeof userId !== "string" ||
		typeof sessionId !== "string" ||
		typeof sessionToken !== "string" ||
		authoritativeSession.session.impersonatedBy
	) {
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}

	const expectedCredentialVersion =
		typeof authoritativeSession.user.credentialVersion === "string" &&
		authoritativeSession.user.credentialVersion
			? authoritativeSession.user.credentialVersion
			: LEGACY_CREDENTIAL_VERSION;
	const adapter = await getCurrentAdapter(context.context.adapter);
	const lockedUser = await adapter.update<{
		banExpires?: Date | string | null;
		banned?: boolean | null;
		credentialVersion?: unknown;
		id?: unknown;
		role?: unknown;
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
		!hasGlobalAdminRole(lockedUser.role) ||
		isActiveUserBan({
			banned: lockedUser.banned ?? null,
			banExpires: lockedUser.banExpires ?? null,
		})
	) {
		throw APIError.from("FORBIDDEN", {
			code: "ADMIN_AUTHORITY_REVOKED",
			message: "Administrator access is required.",
		});
	}

	const lockedSession = await adapter.update<{
		expiresAt?: Date | string | null;
		id?: unknown;
		impersonatedBy?: unknown;
		token?: unknown;
		userId?: unknown;
	}>({
		model: "session",
		where: [
			{ field: "id", value: sessionId },
			{ field: "userId", value: userId },
			{ field: "token", value: sessionToken },
			{ field: "expiresAt", operator: "gt", value: new Date() },
		],
		update: { id: sessionId },
	});
	const lockedSessionExpiresAt =
		lockedSession?.expiresAt instanceof Date
			? lockedSession.expiresAt
			: typeof lockedSession?.expiresAt === "string"
				? new Date(lockedSession.expiresAt)
				: null;
	if (
		!lockedSession ||
		lockedSession.id !== sessionId ||
		lockedSession.userId !== userId ||
		lockedSession.token !== sessionToken ||
		lockedSession.impersonatedBy ||
		!lockedSessionExpiresAt ||
		!Number.isFinite(lockedSessionExpiresAt.getTime()) ||
		lockedSessionExpiresAt.getTime() <= Date.now()
	) {
		throw APIError.from("UNAUTHORIZED", {
			code: "SESSION_CREDENTIAL_STALE",
			message: "The authenticated session is no longer current.",
		});
	}
}

export function isActiveUserBan(
	value: { banned: boolean | null; banExpires: Date | string | null },
	now = Date.now(),
): boolean {
	const banExpires =
		value.banExpires instanceof Date
			? value.banExpires
			: typeof value.banExpires === "string"
				? new Date(value.banExpires)
				: null;
	return (
		value.banned === true && (banExpires === null || banExpires.getTime() > now)
	);
}

function requiresBanRecheck(
	data: Record<string, unknown> | undefined,
): boolean {
	return Boolean(
		data &&
			(Object.hasOwn(data, "banned") || Object.hasOwn(data, "banExpires")),
	);
}

function requireInternalAdapter(context: AdminUserMutationContext) {
	const adapter = context.context.internalAdapter;
	if (!adapter) {
		throw new Error("Better Auth internal adapter is unavailable");
	}
	return adapter;
}

async function normalizePermanentBanAndRevokeSessions(
	context: AdminUserMutationContext,
	options?: { normalizePermanentExpiry?: boolean },
): Promise<void> {
	const userId = context.body?.userId;
	if (typeof userId !== "string") return;
	const adapter = requireInternalAdapter(context);
	if (options?.normalizePermanentExpiry) {
		await adapter.updateUser(userId, {
			banExpires: null,
			updatedAt: new Date(),
		});
	}
	const currentUser = await adapter.findUserById(userId);
	if (
		currentUser &&
		isActiveUserBan({
			banned: currentUser.banned ?? null,
			banExpires: currentUser.banExpires ?? null,
		})
	) {
		// This call executes through the same transaction adapter as the user
		// update. A session cannot survive a banExpires-only reactivation.
		await adapter.deleteUserSessions(userId);
	}
}

function withNormalizedBanExpiry<Result>(result: Result): Result {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return result;
	}
	const user = (result as { user?: unknown }).user;
	if (!user || typeof user !== "object" || Array.isArray(user)) return result;
	return {
		...result,
		user: { ...user, banExpires: null },
	} as Result;
}

/**
 * Better Auth updates the user and then deletes sessions in both admin ban
 * paths. Keep those adapter operations atomic and run cleanup only after the
 * transaction has committed an active ban.
 */
export function wrapAdminBanEndpointsInTransactions(
	plugin: AdminPluginWithMutableEndpoints | undefined,
	afterCommittedActiveBan: (userId: string) => Promise<void>,
): void {
	const adminUpdateUserEndpoint = plugin?.endpoints?.adminUpdateUser;
	if (plugin?.endpoints && typeof adminUpdateUserEndpoint === "function") {
		const protectedAdminUpdateUserEndpoint = Object.assign(
			async (context: AdminUserMutationContext) => {
				if (
					context.body?.data &&
					Object.hasOwn(context.body.data, "credentialVersion")
				) {
					throw APIError.from("BAD_REQUEST", {
						code: "FIELD_NOT_ALLOWED",
						message: "credentialVersion is managed internally.",
					});
				}
				const result = await (
					adminUpdateUserEndpoint as AdminUserMutationEndpoint
				)(context);
				if (!requiresBanRecheck(context.body?.data)) return result;
				const normalizePermanentExpiry =
					context.body?.data?.banned === true &&
					!Object.hasOwn(context.body.data, "banExpires");
				await normalizePermanentBanAndRevokeSessions(context, {
					normalizePermanentExpiry,
				});
				return normalizePermanentExpiry
					? withNormalizedBanExpiry(result)
					: result;
			},
			adminUpdateUserEndpoint,
		);
		plugin.endpoints.adminUpdateUser = wrapEndpointInTransaction(
			protectedAdminUpdateUserEndpoint,
			async (context) => {
				if (!requiresBanRecheck(context.body?.data)) return;
				const userId = context.body?.userId;
				if (typeof userId !== "string") return;
				await afterCommittedActiveBan(userId);
			},
		);
	}

	const banUserEndpoint = plugin?.endpoints?.banUser;
	if (plugin?.endpoints && typeof banUserEndpoint === "function") {
		const protectedBanUserEndpoint = Object.assign(
			async (context: AdminUserMutationContext) => {
				const result = await (banUserEndpoint as AdminUserMutationEndpoint)(
					context,
				);
				const duration = context.body?.banExpiresIn;
				const normalizePermanentExpiry =
					typeof duration !== "number" || duration <= 0;
				await normalizePermanentBanAndRevokeSessions(context, {
					normalizePermanentExpiry,
				});
				return normalizePermanentExpiry
					? withNormalizedBanExpiry(result)
					: result;
			},
			banUserEndpoint,
		);
		plugin.endpoints.banUser = wrapEndpointInTransaction(
			protectedBanUserEndpoint,
			async (context) => {
				const userId = context.body?.userId;
				if (typeof userId !== "string") return;
				await afterCommittedActiveBan(userId);
			},
		);
	}
}

/**
 * Fence every Better Auth administrator mutation in one adapter transaction.
 * The actor user and exact session are locked before endpoint-specific work;
 * therefore a committed ban, demotion, deletion, or session revocation either
 * wins first and rejects this request or waits until its mutation commits.
 */
export function wrapAdminMutationEndpointsInTransactions(
	plugin: AdminPluginWithMutableEndpoints | undefined,
	afterCommittedActiveBan: (userId: string) => Promise<void>,
	fenceActor: (
		context: GlobalAdminMutationContext,
	) => Promise<void> = fenceGlobalAdminMutationActor,
): void {
	if (!plugin?.endpoints) return;

	for (const endpointName of FENCED_ADMIN_MUTATION_ENDPOINTS) {
		const original = plugin.endpoints[endpointName];
		if (typeof original !== "function") continue;
		const endpoint = original as AdminUserMutationEndpoint;
		const protectedEndpoint = Object.assign(
			async (context: GlobalAdminMutationContext) => {
				await fenceActor(context);
				if (
					endpointName === "adminUpdateUser" &&
					context.body?.data &&
					Object.hasOwn(context.body.data, "credentialVersion")
				) {
					throw APIError.from("BAD_REQUEST", {
						code: "FIELD_NOT_ALLOWED",
						message: "credentialVersion is managed internally.",
					});
				}

				const result = await endpoint(context);
				if (
					endpointName === "adminUpdateUser" &&
					requiresBanRecheck(context.body?.data)
				) {
					const normalizePermanentExpiry =
						context.body?.data?.banned === true &&
						!Object.hasOwn(context.body.data, "banExpires");
					await normalizePermanentBanAndRevokeSessions(context, {
						normalizePermanentExpiry,
					});
					return normalizePermanentExpiry
						? withNormalizedBanExpiry(result)
						: result;
				}
				if (endpointName === "banUser") {
					const duration = context.body?.banExpiresIn;
					const normalizePermanentExpiry =
						typeof duration !== "number" || duration <= 0;
					await normalizePermanentBanAndRevokeSessions(context, {
						normalizePermanentExpiry,
					});
					return normalizePermanentExpiry
						? withNormalizedBanExpiry(result)
						: result;
				}
				return result;
			},
			endpoint,
		);
		plugin.endpoints[endpointName] = wrapEndpointInTransaction(
			protectedEndpoint,
			async (context) => {
				const shouldNotify =
					endpointName === "banUser" ||
					(endpointName === "adminUpdateUser" &&
						requiresBanRecheck(context.body?.data));
				if (!shouldNotify) return;
				const userId = context.body?.userId;
				if (typeof userId === "string") {
					await afterCommittedActiveBan(userId);
				}
			},
		);
	}
}
