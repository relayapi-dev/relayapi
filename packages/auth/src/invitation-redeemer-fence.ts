import { getCurrentAdapter } from "@better-auth/core/context";
import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";
import { APIError } from "better-auth/api";
import { isActiveUserBan } from "./admin-ban-endpoints";
import type { TransactionalEndpointContext } from "./atomic-endpoint";

export type InvitationAcceptContext = TransactionalEndpointContext & {
	context: TransactionalEndpointContext["context"] & {
		session?: {
			session: { id?: unknown; token?: unknown; userId?: unknown };
			user: {
				id?: unknown;
				credentialVersion?: unknown;
			};
		} | null;
	};
};

/**
 * Fence Better Auth invitation acceptance against both a concurrent user ban
 * and revocation of the exact accepting session. This runs inside the adapter
 * transaction that also changes invitation status and inserts membership.
 */
export async function fenceInvitationAcceptingSession(
	context: InvitationAcceptContext,
): Promise<void> {
	const authSession = context.context.session;
	const userId = authSession?.user.id;
	const sessionId = authSession?.session.id;
	const sessionToken = authSession?.session.token;
	if (
		typeof userId !== "string" ||
		typeof sessionId !== "string" ||
		typeof sessionToken !== "string"
	) {
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}

	const expectedCredentialVersion =
		typeof authSession?.user.credentialVersion === "string" &&
		authSession.user.credentialVersion
			? authSession.user.credentialVersion
			: LEGACY_CREDENTIAL_VERSION;
	const transactionAdapter = await getCurrentAdapter(context.context.adapter);
	// A no-op generation update is an adapter-portable PostgreSQL row lock. Ban
	// mutations take the same user row before deleting sessions, so either the
	// invitation grant commits first or the post-ban generation predicate misses.
	const lockedUser = await transactionAdapter.update<{
		id?: unknown;
		banned?: boolean | null;
		banExpires?: Date | string | null;
		credentialVersion?: unknown;
	}>({
		model: "user",
		where: [
			{ field: "id", value: userId },
			{
				field: "credentialVersion",
				value: expectedCredentialVersion,
			},
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

	// Keep the exact session alive through membership insertion. Locking it only
	// after the user row matches the ban path's user -> session lock order.
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
}
