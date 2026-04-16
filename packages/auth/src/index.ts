import { apiKey } from "@better-auth/api-key";
import type { Database } from "@relayapi/db";
import {
	account,
	apikey,
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
import { admin, organization as organizationPlugin } from "better-auth/plugins";
import { ac, adminRole, type ownerRole, roles } from "./permissions";

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

							if (membership.length > 0) {
								return {
									data: {
										...sessionData,
										activeOrganizationId: membership[0]!.organizationId,
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
				roles: roles as Record<string, typeof ownerRole>,
				allowUserToCreateOrganization: true,
				organizationLimit: 2,
				creatorRole: "owner",
				membershipLimit: 50,
				sendInvitationEmail: env.sendInvitationEmail
					? async (data) => {
							await env.sendInvitationEmail!({
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
