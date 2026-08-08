import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
} from "better-auth/api";

type EndpointContext = Parameters<typeof getAuthoritativeSessionFromCtx>[0];
type AuthoritativeSession = Awaited<
	ReturnType<typeof getAuthoritativeSessionFromCtx>
>;
type SessionResolver = (
	context: EndpointContext,
) => Promise<AuthoritativeSession>;

export function isOrganizationEndpoint(path: string | undefined): boolean {
	return path?.startsWith("/organization/") === true;
}

export function hasActiveSessionUserBan(
	user: Record<string, unknown>,
	now = Date.now(),
): boolean {
	if (user.banned !== true) return false;
	if (user.banExpires == null) return true;
	const expiry =
		user.banExpires instanceof Date
			? user.banExpires.getTime()
			: typeof user.banExpires === "string" ||
					typeof user.banExpires === "number"
				? new Date(user.banExpires).getTime()
				: Number.NaN;
	// An active ban with malformed expiry data fails closed.
	return !Number.isFinite(expiry) || expiry > now;
}

/**
 * Better Auth's organization plugin normally accepts its signed cookie cache.
 * In a stateful deployment that cache can outlive server-side session deletion,
 * so every client organization endpoint first resolves the authoritative row.
 * Server-only calls without request headers retain Better Auth's documented
 * userId-based behavior.
 */
export async function enforceAuthoritativeOrganizationSession(
	context: EndpointContext,
	resolveSession: SessionResolver = getAuthoritativeSessionFromCtx,
): Promise<void> {
	const authSession = await resolveSession(context);
	if (!authSession) {
		if (!context.request && !context.headers) return;
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}
	if (hasActiveSessionUserBan(authSession.user)) {
		throw APIError.from("UNAUTHORIZED", {
			code: "UNAUTHORIZED",
			message: "Not authenticated.",
		});
	}
}

export function authoritativeOrganizationSessionPlugin(): BetterAuthPlugin {
	return {
		id: "authoritative-organization-session",
		hooks: {
			before: [
				{
					matcher: (context) => isOrganizationEndpoint(context.path),
					handler: createAuthMiddleware((context) =>
						enforceAuthoritativeOrganizationSession(context),
					),
				},
			],
		},
	};
}
