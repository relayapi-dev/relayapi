import { apiKey } from "@better-auth/api-key";
import { LIMITS } from "@relayapi/config";
import type { Database } from "@relayapi/db";
import {
	account,
	and,
	apikey,
	countOwnedFreeOrganizationsForUser,
	eq,
	gt,
	invitation,
	lt,
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
import {
	type TransactionalEndpointContext,
	wrapEndpointInTransaction,
} from "./atomic-endpoint";
import { ac, type ownerRole, roles } from "./permissions";

export interface InvitationEmailData {
	id: string;
	email: string;
	role: string;
	organizationId: string;
	organizationName: string;
	inviterEmail: string;
}

export type AccountEmailKind =
	| "verify-email"
	| "reset-password"
	| "delete-account";

export interface AccountEmailData {
	kind: AccountEmailKind;
	email: string;
	url: string;
	token: string;
}

export interface AuthEnv {
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Require an unexpired pending organization invitation for new identities. */
	requireInvitationForSignUp?: boolean;
	/** Require email/password users to verify their address before signing in. */
	requireEmailVerification?: boolean;
	sendAccountEmail?: (data: AccountEmailData) => Promise<void>;
	sendInvitationEmail?: (data: InvitationEmailData) => Promise<void>;
	afterRemoveMember?: (data: {
		userId: string;
		organizationId: string;
	}) => Promise<void>;
	/**
	 * RelayAPI-owned atomic identity deletion lifecycle. Better Auth's first
	 * child/user delete hook invokes this operation and then suppresses its own
	 * non-transactional session/account/user deletion sequence.
	 */
	deleteUserAtomically?: (data: { userId: string }) => Promise<void>;
}

interface RateLimitValue {
	key: string;
	count: number;
	lastRequest: number;
}

type RateLimitDatabase = Pick<
	Database,
	"delete" | "execute" | "insert" | "select"
>;

const RATE_LIMIT_IDENTIFIER_PREFIX = "relayapi:better-auth-rate-limit:";

async function rateLimitIdentifier(key: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
	);
	const encoded = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${RATE_LIMIT_IDENTIFIER_PREFIX}${encoded}`;
}

function parseRateLimitValue(value: string | undefined): RateLimitValue | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Partial<RateLimitValue>;
		if (
			typeof parsed.key !== "string" ||
			typeof parsed.count !== "number" ||
			!Number.isFinite(parsed.count) ||
			typeof parsed.lastRequest !== "number" ||
			!Number.isFinite(parsed.lastRequest)
		) {
			return null;
		}
		return parsed as RateLimitValue;
	} catch {
		return null;
	}
}

/**
 * Better Auth's atomic rate-limit storage contract backed by PostgreSQL.
 * Advisory transaction locks serialize each IP/path bucket across Worker
 * isolates, while the existing verification table provides expiring storage.
 */
function createRateLimitStorage(db: Database) {
	const lock = (tx: RateLimitDatabase, identifier: string) =>
		tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${identifier}, 0))`,
		);
	const read = async (tx: RateLimitDatabase, identifier: string) => {
		const rows = await tx
			.select({ value: verification.value, expiresAt: verification.expiresAt })
			.from(verification)
			.where(eq(verification.identifier, identifier))
			.limit(1);
		const row = rows[0];
		if (!row || row.expiresAt.getTime() <= Date.now()) return null;
		return parseRateLimitValue(row.value);
	};
	const replace = async (
		tx: RateLimitDatabase,
		identifier: string,
		value: RateLimitValue,
		expiresAt: Date,
	) => {
		await tx
			.delete(verification)
			.where(eq(verification.identifier, identifier));
		await tx.insert(verification).values({
			id: `rl_${crypto.randomUUID()}`,
			identifier,
			value: JSON.stringify(value),
			expiresAt,
		});
	};

	return {
		get: async (key: string): Promise<RateLimitValue | null> =>
			read(db, await rateLimitIdentifier(key)),
		set: async (key: string, value: RateLimitValue): Promise<void> => {
			const identifier = await rateLimitIdentifier(key);
			await db.transaction(async (tx) => {
				await lock(tx, identifier);
				await replace(
					tx,
					identifier,
					{ ...value, key: identifier },
					new Date(Date.now() + 60_000),
				);
			});
		},
		consume: async (
			key: string,
			rule: { window: number; max: number },
		): Promise<{ allowed: boolean; retryAfter: number | null }> => {
			const identifier = await rateLimitIdentifier(key);
			return db.transaction(async (tx) => {
				await lock(tx, identifier);
				const now = Date.now();
				const windowMs = rule.window * 1_000;
				const current = await read(tx, identifier);
				if (
					current &&
					now - current.lastRequest <= windowMs &&
					current.count >= rule.max
				) {
					return {
						allowed: false,
						retryAfter: Math.max(
							1,
							Math.ceil((current.lastRequest + windowMs - now) / 1_000),
						),
					};
				}

				const next: RateLimitValue =
					!current || now - current.lastRequest > windowMs
						? { key: identifier, count: 1, lastRequest: now }
						: {
								key: identifier,
								count: current.count + 1,
								lastRequest: now,
							};
				await replace(tx, identifier, next, new Date(now + windowMs));
				return { allowed: true, retryAfter: null };
			});
		},
	};
}

export function createAuth(db: Database, env: AuthEnv) {
	const { sendInvitationEmail } = env;
	const sendAccountEmail = env.sendAccountEmail;
	const afterRemoveMember = env.afterRemoveMember;
	const deleteUserAtomically = env.deleteUserAtomically;
	const identityDeletionPaths = new Set([
		"/delete-user",
		"/delete-user/callback",
		"/admin/remove-user",
	]);
	const interceptIdentityDelete = async (
		userId: string,
		context: unknown,
	): Promise<false | undefined> => {
		const path = (context as { path?: unknown } | null)?.path;
		if (
			!deleteUserAtomically ||
			typeof path !== "string" ||
			!identityDeletionPaths.has(path)
		) {
			return;
		}
		await deleteUserAtomically({ userId });
		return false;
	};
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
					and(
						eq(organizationCreationReservations.userId, userId),
						lt(organizationCreationReservations.expiresAt, now),
					),
				);
			const freeOrgCount = await countOwnedFreeOrganizationsForUser(tx, userId);
			const activeClaims = await tx
				.select({ id: organizationCreationReservations.id })
				.from(organizationCreationReservations)
				.where(
					and(
						eq(organizationCreationReservations.userId, userId),
						gt(organizationCreationReservations.expiresAt, now),
					),
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
	const revokeRemovedMember = async (data: {
		userId: string;
		organizationId: string;
	}): Promise<void> => {
		if (!afterRemoveMember) return;
		try {
			const membershipStillExists = await db
				.select({ id: member.id })
				.from(member)
				.where(
					sql`${member.userId} = ${data.userId} AND ${member.organizationId} = ${data.organizationId}`,
				)
				.limit(1);
			if (membershipStillExists.length > 0) return;
			await afterRemoveMember(data);
		} catch {
			// Authorization checks membership on every dashboard-key use, so failed
			// post-success cache cleanup cannot restore access. Keep the successful
			// membership mutation response and surface a durable observability signal.
			console.error(
				JSON.stringify({
					event: "post_membership_credential_revocation_failed",
				}),
			);
		}
	};
	// Better Auth does not call organization hooks for /organization/leave.
	// Revoke credentials only from an after hook, and only once the membership is
	// authoritatively absent, so a rejected sole-owner leave has no side effects.
	const membershipLeaveRevocationPlugin: BetterAuthPlugin = {
		id: "membership-leave-revocation",
		hooks: {
			after: [
				{
					matcher: (context) => context.path === "/organization/leave",
					handler: createAuthMiddleware(async (context) => {
						try {
							const organizationId = context.body?.organizationId;
							if (typeof organizationId !== "string") return;
							const authSession = await getAuthoritativeSessionFromCtx(context);
							if (!authSession) return;

							await revokeRemovedMember({
								userId: authSession.user.id,
								organizationId,
							});
						} catch {
							console.error(
								JSON.stringify({
									event: "post_membership_credential_revocation_failed",
								}),
							);
						}
					}),
				},
			],
		},
	};
	const authoritativeAdminSessionPlugin: BetterAuthPlugin = {
		id: "authoritative-admin-session",
		hooks: {
			before: [
				{
					matcher: (context) =>
						context.path?.startsWith("/admin/") === true &&
						context.path !== "/admin/stop-impersonating",
					handler: createAuthMiddleware(async (context) => {
						const authSession = await getAuthoritativeSessionFromCtx(context);
						if (!authSession) {
							throw APIError.from("UNAUTHORIZED", {
								code: "UNAUTHORIZED",
								message: "Not authenticated.",
							});
						}
						const roleValue: unknown = authSession.user.role;
						const roles = (
							Array.isArray(roleValue)
								? roleValue.filter(
										(role): role is string => typeof role === "string",
									)
								: typeof roleValue === "string"
									? roleValue.split(",")
									: []
						).map((role) => role.trim());
						if (!roles.includes("admin")) {
							throw APIError.from("FORBIDDEN", {
								code: "FORBIDDEN",
								message: "Administrator access is required.",
							});
						}
					}),
				},
			],
		},
	};
	const config: Parameters<typeof betterAuth>[0] = {
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, {
			provider: "pg",
			transaction: true,
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
			requireEmailVerification: env.requireEmailVerification ?? false,
			sendResetPassword: sendAccountEmail
				? async ({ user: resetUser, url, token }) => {
						await sendAccountEmail({
							kind: "reset-password",
							email: resetUser.email,
							url,
							token,
						});
					}
				: undefined,
			resetPasswordTokenExpiresIn: 60 * 60,
			revokeSessionsOnPasswordReset: true,
		},
		emailVerification: sendAccountEmail
			? {
					sendOnSignUp: true,
					sendOnSignIn: true,
					autoSignInAfterVerification: true,
					expiresIn: 60 * 60,
					sendVerificationEmail: async ({
						user: unverifiedUser,
						url,
						token,
					}) => {
						await sendAccountEmail({
							kind: "verify-email",
							email: unverifiedUser.email,
							url,
							token,
						});
					},
				}
			: undefined,
		rateLimit: {
			enabled: true,
			window: 60,
			max: 100,
			customStorage: createRateLimitStorage(db),
			customRules: {
				"/sign-in/email": { window: 60, max: 5 },
				"/sign-in/social": { window: 60, max: 10 },
				"/sign-up/email": { window: 60, max: 5 },
				"/request-password-reset": { window: 60, max: 3 },
				"/send-verification-email": { window: 60, max: 3 },
				"/delete-user": { window: 60, max: 3 },
			},
		},
		advanced: {
			ipAddress: {
				ipAddressHeaders: ["cf-connecting-ip"],
			},
		},
		account: {
			// Better Auth login-provider credentials are application-encrypted at
			// rest using BETTER_AUTH_SECRET before reaching auth.account.
			encryptOAuthTokens: true,
		},
		user: {
			deleteUser: {
				enabled: true,
				deleteTokenExpiresIn: 30 * 60,
				sendDeleteAccountVerification: sendAccountEmail
					? async ({ user: deletingUser, url, token }) => {
							await sendAccountEmail({
								kind: "delete-account",
								email: deletingUser.email,
								url,
								token,
							});
						}
					: undefined,
			},
		},
		session: {
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60,
			},
		},
		databaseHooks: {
			user: {
				create: env.requireInvitationForSignUp
					? {
							before: async (userData, context) => {
								// Authenticated administrators may deliberately provision a user;
								// public email and first-time OAuth creation require an invite.
								if (context?.path.startsWith("/admin/")) {
									return { data: userData };
								}
								const normalizedEmail = userData.email.trim().toLowerCase();
								const activeInvitations = await db
									.select({ id: invitation.id })
									.from(invitation)
									.where(
										sql`lower(${invitation.email}) = ${normalizedEmail} AND ${invitation.status} = 'pending' AND ${invitation.expiresAt} > now()`,
									)
									.limit(1);
								if (activeInvitations.length === 0) {
									throw APIError.from("FORBIDDEN", {
										code: "INVITATION_REQUIRED",
										message:
											"A valid invitation is required to create an account.",
									});
								}
								return {
									data: { ...userData, email: normalizedEmail },
								};
							},
						}
					: undefined,
				delete: deleteUserAtomically
					? {
							before: (deletingUser, context) =>
								interceptIdentityDelete(deletingUser.id, context),
						}
					: undefined,
			},
			account: {
				delete: deleteUserAtomically
					? {
							before: (deletingAccount, context) =>
								interceptIdentityDelete(deletingAccount.userId, context),
						}
					: undefined,
			},
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
				delete: deleteUserAtomically
					? {
							before: (deletingSession, context) =>
								interceptIdentityDelete(deletingSession.userId, context),
						}
					: undefined,
			},
		},
		plugins: [
			apiKey(),
			authoritativeAdminSessionPlugin,
			admin(),
			membershipLeaveRevocationPlugin,
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
					afterRemoveMember: async ({
						user: removedUser,
						organization: removedFrom,
					}) => {
						await revokeRemovedMember({
							userId: removedUser.id,
							organizationId: removedFrom.id,
						});
					},
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

	type OrganizationCreateContext = TransactionalEndpointContext & {
		body?: { slug?: unknown; userId?: unknown };
		context: TransactionalEndpointContext["context"] & {
			session?: { user: { id: string } } | null;
		};
	};
	type OrganizationCreateResult = {
		members?: Array<{ userId?: string }>;
	};
	const organizationAuthPlugin = config.plugins?.find(
		(plugin) => plugin.id === "organization",
	);
	const createOrganizationEndpoint =
		organizationAuthPlugin?.endpoints?.createOrganization;
	if (organizationAuthPlugin?.endpoints && createOrganizationEndpoint) {
		organizationAuthPlugin.endpoints.createOrganization =
			wrapEndpointInTransaction(
				createOrganizationEndpoint as unknown as ((
					context: OrganizationCreateContext,
				) => Promise<OrganizationCreateResult>) & {
					path?: unknown;
					method?: unknown;
					options?: unknown;
					headers?: unknown;
				},
				async (context, result) => {
					const bodyUserId = context.body?.userId;
					const creatorId =
						result.members?.[0]?.userId ??
						(typeof bodyUserId === "string" ? bodyUserId : undefined) ??
						context.context.session?.user.id;
					const slug = context.body?.slug;
					if (!creatorId || typeof slug !== "string") return;
					await db
						.delete(organizationCreationReservations)
						.where(
							and(
								eq(organizationCreationReservations.userId, creatorId),
								eq(organizationCreationReservations.slug, slug),
							),
						);
				},
			) as never;
	}

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
