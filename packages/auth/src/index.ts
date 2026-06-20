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
	session,
	user,
	verification,
} from "@relayapi/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin, organization as organizationPlugin } from "better-auth/plugins";
import { ac, type ownerRole, roles } from "./permissions";

export interface InvitationEmailData {
	id: string;
	email: string;
	role: string;
	organizationName: string;
	inviterEmail: string;
}

export interface AuthEnv {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	sendInvitationEmail?: (data: InvitationEmailData) => Promise<void>;
}

export function createAuth(db: Database, env: AuthEnv) {
	const { sendInvitationEmail } = env;
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
		session: {
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
			},
		},
		databaseHooks: {
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
			organizationPlugin({
				ac,
				roles: roles as unknown as Record<string, typeof ownerRole>,
				allowUserToCreateOrganization: true,
				creatorRole: "owner",
				membershipLimit: 50,
				organizationHooks: {
					// Free-org cap: only orgs the user OWNS without an active paid
					// subscription count; paid orgs are unlimited. (The small TOCTOU
					// window on simultaneous creates is acceptable for a low-frequency,
					// button-disabled UI action.)
					beforeCreateOrganization: async ({ user: creatingUser }) => {
						const freeOrgCount = await countOwnedFreeOrganizationsForUser(
							db,
							creatingUser.id,
						);
						if (freeOrgCount >= LIMITS.maxFreeOrgsPerUser) {
							throw APIError.from("FORBIDDEN", {
								code: "FREE_ORGANIZATION_LIMIT_REACHED",
								message: `You've reached the limit of ${LIMITS.maxFreeOrgsPerUser} free organizations. Upgrade an organization to Pro to create a new one.`,
							});
						}
					},
				},
				sendInvitationEmail: sendInvitationEmail
					? async (data) => {
							await sendInvitationEmail({
								id: data.id,
								email: data.email,
								role: data.role,
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
