import { apiKey } from "@better-auth/api-key";
import { LIMITS } from "@relayapi/config";
import type { Database } from "@relayapi/db";
import {
	account,
	apikey,
	countOwnedFreeOrganizationsForUser,
	eq,
	invitation,
	member,
	organization,
	organizationCreationReservations,
	session,
	sql,
	user,
	verification,
} from "@relayapi/db";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { admin, organization as organizationPlugin } from "better-auth/plugins";
import { ac, type ownerRole, roles } from "./permissions";

export interface InvitationEmailData {
	id: string;
	email: string;
	role: string;
	organizationId: string;
	organizationName: string;
	inviterEmail: string;
}

export interface AuthEnv {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	sendInvitationEmail?: (data: InvitationEmailData) => Promise<void>;
	beforeRemoveMember?: (data: {
		userId: string;
		organizationId: string;
	}) => Promise<void>;
	/**
	 * RelayAPI-owned identity deletion lifecycle. This hook must revoke
	 * principal-bound credentials and enforce organization ownership before the
	 * Better Auth adapter removes the user row.
	 */
	beforeDeleteUser?: (data: { userId: string }) => Promise<void>;
}

export function createAuth(db: Database, env: AuthEnv) {
	const { sendInvitationEmail } = env;
	const beforeRemoveMember = env.beforeRemoveMember;
	const beforeDeleteUser = env.beforeDeleteUser;
	const reserveFreeOrganizationSlot = async (
		userId: string,
		slug: string,
	): Promise<void> => {
		if (!slug) {
			throw APIError.from("BAD_REQUEST", {
				code: "ORGANIZATION_SLUG_REQUIRED",
				message: "Organization slug is required.",
			});
		}
		await db.transaction(async (tx) => {
			const now = new Date();
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relayapi:free-org:${userId}`}, 0))`,
			);
			await tx
				.delete(organizationCreationReservations)
				.where(
					sql`${organizationCreationReservations.userId} = ${userId} AND ${organizationCreationReservations.expiresAt} <= ${now}`,
				);
			const freeOrgCount = await countOwnedFreeOrganizationsForUser(tx, userId);
			const activeClaims = await tx
				.select({ id: organizationCreationReservations.id })
				.from(organizationCreationReservations)
				.where(
					sql`${organizationCreationReservations.userId} = ${userId} AND ${organizationCreationReservations.expiresAt} > ${now}`,
				);
			if (freeOrgCount + activeClaims.length >= LIMITS.maxFreeOrgsPerUser) {
				throw APIError.from("FORBIDDEN", {
					code: "FREE_ORGANIZATION_LIMIT_REACHED",
					message: `You've reached the limit of ${LIMITS.maxFreeOrgsPerUser} free organizations. Upgrade an organization to Pro to create a new one.`,
				});
			}
			const [reserved] = await tx
				.insert(organizationCreationReservations)
				.values({
					userId,
					slug,
					expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
				})
				.onConflictDoNothing()
				.returning({ id: organizationCreationReservations.id });
			if (!reserved) {
				throw APIError.from("CONFLICT", {
					code: "ORGANIZATION_CREATION_IN_PROGRESS",
					message: "An organization with this slug is already being created.",
				});
			}
		});
	};
	// Better Auth's organization beforeRemoveMember hook covers administrator
	// removal but is not called by /organization/leave. Intercept that one route,
	// validate the only-owner condition the endpoint enforces, then run the same
	// revocation before its member delete.
	const membershipLeaveRevocationPlugin: BetterAuthPlugin | null =
		beforeRemoveMember
			? {
					id: "membership-leave-revocation",
					hooks: {
						before: [
							{
								matcher: (context) => context.path === "/organization/leave",
								handler: createAuthMiddleware(async (context) => {
									const organizationId = context.body?.organizationId;
									if (typeof organizationId !== "string") return;
									const authSession =
										await getAuthoritativeSessionFromCtx(context);
									if (!authSession) return;

									const memberships = await db
										.select({ userId: member.userId, role: member.role })
										.from(member)
										.where(eq(member.organizationId, organizationId));
									const leavingMembership = memberships.find(
										(row) => row.userId === authSession.user.id,
									);
									if (!leavingMembership) return;

									const isOwner = leavingMembership.role
										.split(",")
										.some((role) => role.trim() === "owner");
									if (
										isOwner &&
										memberships.filter((row) =>
											row.role
												.split(",")
												.some((role) => role.trim() === "owner"),
										).length <= 1
									) {
										return;
									}

									await beforeRemoveMember({
										userId: authSession.user.id,
										organizationId,
									});
								}),
							},
						],
					},
				}
			: null;
	const config: Parameters<typeof betterAuth>[0] = {
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: {
				user,
				session,
				account,
				verification,
				apikey,
				organization,
				member,
				invitation,
			},
		}),
		emailAndPassword: {
			enabled: true,
		},
		account: {
			// Better Auth login-provider credentials are application-encrypted at
			// rest using BETTER_AUTH_SECRET before reaching auth.account.
			encryptOAuthTokens: true,
		},
		user: {
			deleteUser: {
				enabled: true,
			},
		},
		session: {
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
			},
		},
		databaseHooks: {
			user: beforeDeleteUser
				? {
						delete: {
							before: async (userData) => {
								await beforeDeleteUser({ userId: userData.id });
							},
						},
					}
				: undefined,
			session: {
				create: {
					before: async (sessionData) => {
						try {
							const membership = await db
								.select({ organizationId: member.organizationId })
								.from(member)
								.where(eq(member.userId, sessionData.userId))
								.limit(1);

							const firstMembership = membership[0];
							if (firstMembership) {
								return {
									data: {
										...sessionData,
										activeOrganizationId: firstMembership.organizationId,
									},
								};
							}
						} catch (error) {
							console.error(
								"Failed to resolve active organization on session create:",
								error,
							);
						}
						return { data: sessionData };
					},
				},
			},
		},
		plugins: [
			apiKey(),
			admin(),
			...(membershipLeaveRevocationPlugin
				? [membershipLeaveRevocationPlugin]
				: []),
			organizationPlugin({
				ac,
				roles: roles as unknown as Record<string, typeof ownerRole>,
				// Tenant erasure must always pass through RelayAPI's durable
				// requestTenantDeletion lifecycle rather than a raw adapter delete.
				disableOrganizationDeletion: true,
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
				membershipLimit: 50,
				organizationHooks: {
					// Reserve quota durably before Better Auth's later organization and
					// owner-member inserts. The advisory lock serializes claims per user.
					beforeCreateOrganization: async ({
						user: creatingUser,
						organization: creatingOrganization,
					}) => {
						await reserveFreeOrganizationSlot(
							creatingUser.id,
							creatingOrganization.slug ?? "",
						);
					},
					afterCreateOrganization: async ({
						user: creatingUser,
						organization: createdOrganization,
					}) => {
						await db
							.delete(organizationCreationReservations)
							.where(
								sql`${organizationCreationReservations.userId} = ${creatingUser.id} AND ${organizationCreationReservations.slug} = ${createdOrganization.slug}`,
							);
					},
					beforeRemoveMember: beforeRemoveMember
						? async ({ user: removedUser, organization: removedFrom }) => {
								await beforeRemoveMember({
									userId: removedUser.id,
									organizationId: removedFrom.id,
								});
							}
						: undefined,
				},
				sendInvitationEmail: sendInvitationEmail
					? async (data) => {
							await sendInvitationEmail({
								id: data.id,
								email: data.email,
								role: data.role,
								organizationId: data.organization.id,
								organizationName: data.organization.name,
								inviterEmail: data.inviter.user.email,
							});
						}
					: undefined,
			}),
		],
	};

	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
		config.socialProviders = {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		};
	}

	return betterAuth(config);
}

export type Auth = ReturnType<typeof createAuth>;

export { ac, adminRole, memberRole, ownerRole, roles } from "./permissions";
