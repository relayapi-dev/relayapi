import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { createAuth } from "@relayapi/auth";
import {
	createDb,
	invitation,
	member,
	organization as authOrganization,
	session as authSession,
	user as authUser,
} from "@relayapi/db";
import { eq, and, gt } from "drizzle-orm";

const PROTECTED_PATHS = ["/app"];
const AUTH_PAGES = new Set(["/login", "/signup"]);

function shouldResolveSession(path: string): boolean {
	return (
		path.startsWith("/app") ||
		path.startsWith("/api/") ||
		path.startsWith("/invite/") ||
		AUTH_PAGES.has(path)
	);
}

function shouldLoadFullOrganization(path: string): boolean {
	return path.startsWith("/app");
}

function extractSessionToken(headers: Headers): string | null {
	const cookies = headers.get("Cookie") || "";
	const match = cookies.match(
		/(?:__Secure-)?better-auth\.session_token=([^;]+)/,
	);
	return match?.[1] || null;
}

// In-memory session cache (60s TTL)
interface CachedSession {
	user: Record<string, unknown>;
	session: Record<string, unknown>;
	organization: Record<string, unknown> | null;
	hasFullOrganization: boolean;
	timestamp: number;
}

const sessionCache = new Map<string, CachedSession>();
const CACHE_TTL = 60_000;
const CACHE_MAX_SIZE = 500;

function writeSessionCache(
	sessionToken: string,
	entry: Omit<CachedSession, "timestamp">,
) {
	if (sessionCache.size >= CACHE_MAX_SIZE) {
		const entries = [...sessionCache.entries()].sort(
			(a, b) => a[1].timestamp - b[1].timestamp,
		);
		const evictCount = Math.floor(CACHE_MAX_SIZE / 4);
		for (let i = 0; i < evictCount; i++) {
			const cacheEntry = entries[i];
			if (cacheEntry) sessionCache.delete(cacheEntry[0]);
		}
	}

	sessionCache.set(sessionToken, {
		...entry,
		timestamp: Date.now(),
	});
}

async function getOrganizationSummary(
	db: ReturnType<typeof createDb>,
	organizationId: string,
): Promise<Record<string, unknown> | null> {
	const [org] = await db
		.select({
			id: authOrganization.id,
			name: authOrganization.name,
			slug: authOrganization.slug,
			logo: authOrganization.logo,
		})
		.from(authOrganization)
		.where(eq(authOrganization.id, organizationId))
		.limit(1);

	if (!org) return null;

	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		logo: org.logo,
	};
}

async function getSessionState(
	db: ReturnType<typeof createDb>,
	sessionToken: string,
	needsFullOrg: boolean,
): Promise<Omit<CachedSession, "timestamp"> | null> {
	const [row] = needsFullOrg
		? await db
				.select({
					sessionId: authSession.id,
					sessionUserId: authSession.userId,
					activeOrganizationId: authSession.activeOrganizationId,
					impersonatedBy: authSession.impersonatedBy,
					expiresAt: authSession.expiresAt,
					userId: authUser.id,
					userName: authUser.name,
					userEmail: authUser.email,
					userImage: authUser.image,
					userRole: authUser.role,
					orgId: authOrganization.id,
					orgName: authOrganization.name,
					orgSlug: authOrganization.slug,
					orgLogo: authOrganization.logo,
				})
				.from(authSession)
				.innerJoin(authUser, eq(authSession.userId, authUser.id))
				.leftJoin(
					authOrganization,
					eq(authSession.activeOrganizationId, authOrganization.id),
				)
				.where(
					and(
						eq(authSession.token, sessionToken),
						gt(authSession.expiresAt, new Date()),
					),
				)
				.limit(1)
		: await db
				.select({
					sessionId: authSession.id,
					sessionUserId: authSession.userId,
					activeOrganizationId: authSession.activeOrganizationId,
					impersonatedBy: authSession.impersonatedBy,
					expiresAt: authSession.expiresAt,
					userId: authUser.id,
					userName: authUser.name,
					userEmail: authUser.email,
					userImage: authUser.image,
					userRole: authUser.role,
				})
				.from(authSession)
				.innerJoin(authUser, eq(authSession.userId, authUser.id))
				.where(
					and(
						eq(authSession.token, sessionToken),
						gt(authSession.expiresAt, new Date()),
					),
				)
				.limit(1);

	if (!row) return null;

	const user: Record<string, unknown> = {
		id: row.userId,
		name: row.userName,
		email: row.userEmail,
		image: row.userImage,
		role: row.userRole,
	};

	const session: Record<string, unknown> = {
		id: row.sessionId,
		userId: row.sessionUserId,
		activeOrganizationId: row.activeOrganizationId,
		impersonatedBy: row.impersonatedBy,
		expiresAt: row.expiresAt.toISOString(),
	};

	let organization: Record<string, unknown> | null = null;
	if (row.activeOrganizationId) {
		const fullOrgRow = row as typeof row & {
			orgId?: string | null;
			orgName?: string | null;
			orgSlug?: string | null;
			orgLogo?: string | null;
		};
		if (fullOrgRow.orgSlug) {
			organization = {
				id: fullOrgRow.orgId ?? row.activeOrganizationId,
				name: fullOrgRow.orgName,
				slug: fullOrgRow.orgSlug,
				logo: fullOrgRow.orgLogo,
			};
		} else {
			organization = { id: row.activeOrganizationId };
		}
	}

	return {
		user,
		session,
		organization,
		hasFullOrganization: !!organization && "slug" in organization,
	};
}

async function userHasOrganizations(
	db: ReturnType<typeof createDb>,
	userId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: member.id })
		.from(member)
		.where(eq(member.userId, userId))
		.limit(1);

	return rows.length > 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const path = context.url.pathname;

	// Skip static assets
	const ext = path.split(".").pop();
	if (
		ext &&
		/^(js|css|woff2?|svg|png|jpg|jpeg|gif|ico|webp|map|ttf|eot)$/.test(ext)
	) {
		return next();
	}

	// Skip auth API routes from the outer try-catch redirect
	// (they need to return proper JSON errors, not redirects)
	const isAuthRoute = path.startsWith("/api/auth/");

	try {
		// --- Per-request lazy DB + Auth (Cloudflare workerd requires fresh I/O) ---
		const cfEnv = env as Record<string, any>;
		const shouldResolveAuthState = shouldResolveSession(path);
		const needsFullOrg = shouldLoadFullOrganization(path);

		let _db: ReturnType<typeof createDb> | undefined;
		let _auth: ReturnType<typeof createAuth> | undefined;

		const getDb = () => {
			if (!_db) {
				const connStr =
					cfEnv.HYPERDRIVE?.connectionString || cfEnv.DATABASE_URL;
				_db = createDb(connStr);
			}
			return _db;
		};

		const getAuth = () => {
			if (!_auth) {
				_auth = createAuth(getDb(), {
					BETTER_AUTH_SECRET: cfEnv.BETTER_AUTH_SECRET,
					BETTER_AUTH_URL: cfEnv.BETTER_AUTH_URL || context.url.origin,
					GOOGLE_CLIENT_ID: cfEnv.GOOGLE_CLIENT_ID,
					GOOGLE_CLIENT_SECRET: cfEnv.GOOGLE_CLIENT_SECRET,
					sendInvitationEmail: async (data) => {
						const [{ render }, { Resend }, { InvitationEmail }] =
							await Promise.all([
								import("@react-email/render"),
								import("resend"),
								import("../lib/emails/invitation-email"),
							]);

						const baseUrl =
							cfEnv.BETTER_AUTH_URL || context.url.origin;
						const inviteUrl = `${baseUrl}/invite/${data.id}`;

						const html = await render(
							InvitationEmail({
								invitedByEmail: data.inviterEmail,
								organizationName: data.organizationName,
								role: data.role,
								inviteUrl,
							}),
						);

						const emailMessage = {
							id: crypto.randomUUID(),
							to: data.email,
							subject: `You've been invited to join ${data.organizationName} on RelayAPI`,
							html,
							from: "RelayAPI <notifications@relayapi.dev>",
						};

						const queue = cfEnv.EMAIL_QUEUE as
							| { send(message: unknown): Promise<void> }
							| undefined;
						if (queue) {
							await queue.send(emailMessage);
							console.log(
								`[Email] Enqueued invitation email to ${data.email}`,
							);
						} else if (cfEnv.RESEND_API_KEY) {
							const resend = new Resend(cfEnv.RESEND_API_KEY);
							await resend.emails.send({
								from: emailMessage.from,
								to: emailMessage.to,
								subject: emailMessage.subject,
								html: emailMessage.html,
							});
							console.log(
								`[Email] Sent invitation email directly to ${data.email}`,
							);
						} else {
							console.warn(
								`[Email] No EMAIL_QUEUE or RESEND_API_KEY — invitation email to ${data.email} skipped`,
							);
						}
					},
				});
			}
			return _auth;
		};

		// Expose lazy getters on locals
		Object.defineProperty(context.locals, "db", {
			get: getDb,
			configurable: true,
			enumerable: true,
		});
		Object.defineProperty(context.locals, "auth", {
			get: getAuth,
			configurable: true,
			enumerable: true,
		});

		// Expose KV binding
		if (cfEnv.KV) {
			context.locals.kv = cfEnv.KV;
		}

		// --- Session resolution ---
		const sessionToken = extractSessionToken(context.request.headers);

		const isAuthMutation =
			(context.request.method === "POST" ||
				context.request.method === "DELETE") &&
			path.startsWith("/api/auth/");

		if (isAuthMutation && sessionToken) {
			sessionCache.delete(sessionToken);
		}

		let user: Record<string, unknown> | null = null;
		let session: Record<string, unknown> | null = null;
		let org: Record<string, unknown> | null = null;
		let cacheHit = false;
		let refreshFullOrgFromCache = false;

		if (!isAuthMutation && sessionToken && shouldResolveAuthState) {
			const cached = sessionCache.get(sessionToken);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
				user = cached.user;
				session = cached.session;
				org = cached.organization;
				cacheHit = true;
				refreshFullOrgFromCache =
					needsFullOrg &&
					!!(session as any)?.activeOrganizationId &&
					!cached.hasFullOrganization;
			} else if (cached) {
				sessionCache.delete(sessionToken);
			}
		}

		if (sessionToken && shouldResolveAuthState && (!cacheHit || refreshFullOrgFromCache)) {
			try {
				if (refreshFullOrgFromCache) {
					const activeOrgId = (session as any)?.activeOrganizationId;
					if (activeOrgId && user && session) {
						try {
							org =
								(await getOrganizationSummary(getDb(), activeOrgId)) ?? {
									id: activeOrgId,
								};
						} catch (e) {
							console.error("Failed to get active organization:", e);
							org = { id: activeOrgId };
						}

						if (!isAuthMutation) {
							writeSessionCache(sessionToken, {
								user,
								session,
								organization: org,
								hasFullOrganization: !!org && "slug" in org,
							});
						}
					}
				} else {
					const sessionState = await getSessionState(
						getDb(),
						sessionToken,
						needsFullOrg,
					);
					if (sessionState) {
						user = sessionState.user;
						session = sessionState.session;
						org = sessionState.organization;

						if (!isAuthMutation) {
							writeSessionCache(sessionToken, {
								user,
								session,
								organization: org,
								hasFullOrganization: sessionState.hasFullOrganization,
							});
						}
					}
				}
			} catch (error) {
				console.error("Failed to get session:", error);
			}
		}

		context.locals.user = user;
		context.locals.session = session;
		context.locals.organization = org;

		// --- Route protection ---
		const isProtectedPath = PROTECTED_PATHS.some((p) => path.startsWith(p));

		if (isProtectedPath && !user) {
			return context.redirect(`/login?redirect=${encodeURIComponent(path)}`);
		}

		// --- Admin route protection ---
		if (user && path.startsWith("/app/admin")) {
			const userRole = (user as any).role;
			if (userRole !== "admin") {
				return context.redirect("/app");
			}
		}

		// --- Organization resolution for /app/* (except /app/onboarding and /app/invitations) ---
		if (
			user &&
			path.startsWith("/app") &&
			path !== "/app/onboarding" &&
			path !== "/app/invitations"
		) {
			const activeOrgId = (session as any)?.activeOrganizationId;
			if (!activeOrgId && !org) {
				// Check if user has any organizations
				try {
					const hasOrganizations = await userHasOrganizations(
						getDb(),
						(user as any).id as string,
					);
					if (!hasOrganizations) {
						// Check if user has pending invitations
						try {
							const db = getDb();
							const userEmail = (user as any).email as string;
							const pending = await db
								.select({ id: invitation.id })
								.from(invitation)
								.where(
									and(
										eq(invitation.email, userEmail),
										eq(invitation.status, "pending"),
									),
								)
								.limit(1);
							if (pending.length > 0) {
								return context.redirect("/app/invitations");
							}
						} catch (e) {
							console.error("Failed to check pending invitations:", e);
						}
						return context.redirect("/app/onboarding");
					}
					// User has orgs but none active — client will set active on load
				} catch (e) {
					console.error("Failed to list organizations:", e);
					return context.redirect("/app/onboarding");
				}
			}
		}

		// Redirect away from onboarding if user already has active org
		if (user && path === "/app/onboarding" && org) {
			return context.redirect("/app");
		}

		// Redirect logged-in users away from auth pages
		if (user && (path === "/login" || path === "/signup")) {
			const redirectParam = context.url.searchParams.get("redirect");
			if (redirectParam && redirectParam.startsWith("/invite/")) {
				return context.redirect(redirectParam);
			}
			return context.redirect("/app");
		}

		const response = await next();

		// Prevent browsers/CDN from caching HTML pages so they always
		// fetch fresh references to hashed assets after a new deploy.
		const ct = response.headers.get("Content-Type") || "";
		if (ct.includes("text/html")) {
			response.headers.set(
				"Cache-Control",
				"no-cache, no-store, must-revalidate",
			);
		}

		return response;
	} catch (error) {
		console.error("Middleware error:", error);
		const isProtectedPath = PROTECTED_PATHS.some((p) => path.startsWith(p));
		if (isProtectedPath && !isAuthRoute) {
			return context.redirect(`/login?redirect=${encodeURIComponent(path)}`);
		}
		return next();
	}
});
