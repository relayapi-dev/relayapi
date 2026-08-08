import {
	invitation,
	LEGACY_CREDENTIAL_VERSION,
	member,
	organization as organizationTable,
} from "@relayapi/db";
import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";

/**
 * Minimal authenticated shell context used by local frontend development.
 * The deployed app remains authoritative for session validation, live
 * membership checks, and organization data; no database credential is shared
 * with the local Astro process.
 */
export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	const session = context.locals.session;
	if (!user || !session) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const organizationId = context.locals.organization?.id as string | undefined;
	const organizationPromise = organizationId
		? context.locals.db
				.select({
					id: organizationTable.id,
					name: organizationTable.name,
					slug: organizationTable.slug,
					logo: organizationTable.logo,
				})
				.from(organizationTable)
				.where(eq(organizationTable.id, organizationId))
				.limit(1)
		: Promise.resolve([]);
	const onboardingStatePromise = organizationId
		? Promise.resolve({
				hasOrganizations: true,
				hasPendingInvitations: false,
			})
		: Promise.all([
				context.locals.db
					.select({ id: member.id })
					.from(member)
					.where(eq(member.userId, user.id as string))
					.limit(1),
				context.locals.db
					.select({ id: invitation.id })
					.from(invitation)
					.where(
						and(
							eq(invitation.email, user.email as string),
							eq(invitation.status, "pending"),
						),
					)
					.limit(1),
			]).then(([memberships, invitations]) => ({
				hasOrganizations: memberships.length > 0,
				hasPendingInvitations: invitations.length > 0,
			}));
	const [organizationRows, onboardingState] = await Promise.all([
		organizationPromise,
		onboardingStatePromise,
	]);

	return Response.json(
		{
			user: {
				id: user.id,
				name: user.name,
				email: user.email,
				image: user.image ?? null,
				role: user.role ?? null,
				credentialVersion:
					user.credentialVersion ?? LEGACY_CREDENTIAL_VERSION,
			},
			session: {
				id: session.id,
				userId: session.userId,
				activeOrganizationId: session.activeOrganizationId ?? null,
				impersonatedBy: session.impersonatedBy ?? null,
				expiresAt: session.expiresAt ?? null,
			},
			organization: organizationRows[0] ?? null,
			organizationMembershipRole: context.locals.organizationMembershipRole,
			...onboardingState,
		},
		{ headers: { "Cache-Control": "private, no-store" } },
	);
};
