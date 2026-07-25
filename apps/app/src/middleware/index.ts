import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { type AuthEnv, createAuth } from "@relayapi/auth";
import {
	organization as authOrganization,
	createDb,
	invitation,
	member,
} from "@relayapi/db";
import { getCookieCache } from "better-auth/cookies";
import { and, eq } from "drizzle-orm";
import { normalizeAuthRedirect } from "../lib/auth-redirect";
import { revokeDashboardPrincipal } from "../lib/dashboard-principal-revocation";
import {
	fetchRemoteDashboardContext,
	proxyRemoteDashboardRequest,
	type RemoteDashboardContext,
	resolveRemoteDashboardOrigin,
} from "../lib/remote-dashboard";
import { applyAppSecurityHeaders } from "../lib/security-headers";
import { isSelfHostedDeployment } from "../lib/deployment-mode";
import { deleteUserAtomically } from "../lib/user-deletion";

const PROTECTED_PATHS = ["/app"];
const AUTH_PAGES = new Set(["/login", "/signup"]);
const DEFAULT_PRODUCTION_APP_ORIGIN = "https://relayapi.dev";
const STATIC_ASSET_EXTENSIONS =
	/^(js|css|woff2?|svg|png|jpg|jpeg|gif|ico|webp|map|ttf|eot)$/;

type Database = ReturnType<typeof createDb>;
type AuthInstance = ReturnType<typeof createAuth>;

interface AuthUser {
	id: string;
	name: string | null;
	email: string;
	image?: string | null;
	role?: string | null;
	[key: string]: unknown;
}

interface AuthSessionRecord {
	id: string;
	userId: string;
	activeOrganizationId?: string | null;
	impersonatedBy?: string | null;
	expiresAt?: string | Date;
	[key: string]: unknown;
}

interface SessionState {
	user: AuthUser;
	session: AuthSessionRecord;
}

interface OrganizationSummary {
	id: string;
	name: string | null;
	slug: string | null;
	logo: string | null;
	[key: string]: unknown;
}

type CfEnv = Cloudflare.Env;

function isStaticAssetPath(path: string): boolean {
	const ext = path.split(".").pop();
	return !!ext && STATIC_ASSET_EXTENSIONS.test(ext);
}

function shouldResolveSession(path: string): boolean {
	return (
		path.startsWith("/app") ||
		path.startsWith("/invite/") ||
		AUTH_PAGES.has(path) ||
		(path.startsWith("/api/") && !path.startsWith("/api/auth/"))
	);
}

function shouldLoadOrganizationSummary(path: string): boolean {
	return path.startsWith("/app");
}

function shouldCheckOnboarding(path: string): boolean {
	return (
		path.startsWith("/app") &&
		path !== "/app/onboarding" &&
		path !== "/app/invitations"
	);
}

function requiresAuthoritativeSession(url: URL): boolean {
	return (
		url.pathname.startsWith("/app/admin") ||
		url.pathname.startsWith("/api/admin") ||
		(url.pathname === "/api/dashboard-context" &&
			url.searchParams.get("authoritative") === "1")
	);
}

function mergeHeaders(target: Headers, source: Headers | null): void {
	if (!source) return;

	const getSetCookie = (
		source as Headers & {
			getSetCookie?: () => string[];
		}
	).getSetCookie;

	if (typeof getSetCookie === "function") {
		for (const cookie of getSetCookie.call(source)) {
			target.append("set-cookie", cookie);
		}
	}

	for (const [key, value] of source.entries()) {
		if (key.toLowerCase() === "set-cookie") {
			if (typeof getSetCookie !== "function") {
				target.append(key, value);
			}
			continue;
		}

		target.set(key, value);
	}
}

function createInvitationEmailSender(
	cfEnv: CfEnv,
	baseUrl: string,
): NonNullable<AuthEnv["sendInvitationEmail"]> {
	return async (data) => {
		const [{ render }, { Resend }, { InvitationEmail }] = await Promise.all([
			import("@react-email/render"),
			import("resend"),
			import("../lib/emails/invitation-email"),
		]);

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
			id: `invitation:${data.id}`,
			organization_id: data.organizationId,
			to: data.email,
			subject: `You've been invited to join ${data.organizationName} on RelayAPI`,
			html,
			from: "RelayAPI <notifications@relayapi.dev>",
		};

		const queue = cfEnv.EMAIL_QUEUE;

		if (queue) {
			await queue.send(emailMessage);
			console.info(JSON.stringify({ event: "invitation_email_enqueued" }));
			return;
		}

		if (cfEnv.RESEND_API_KEY) {
			const resend = new Resend(cfEnv.RESEND_API_KEY);
			const { error } = await resend.emails.send(
				{
					from: emailMessage.from,
					to: emailMessage.to,
					subject: emailMessage.subject,
					html: emailMessage.html,
				},
				{ idempotencyKey: emailMessage.id },
			);
			if (error) {
				throw new Error(
					`Invitation email provider rejected request: ${error.name}`,
				);
			}
			console.info(JSON.stringify({ event: "invitation_email_sent_directly" }));
			return;
		}

		console.warn(
			JSON.stringify({ event: "invitation_email_delivery_unconfigured" }),
		);
	};
}

function createAccountEmailSender(
	cfEnv: CfEnv,
): NonNullable<AuthEnv["sendAccountEmail"]> {
	return async (data) => {
		if (!cfEnv.RESEND_API_KEY) {
			console.error(
				JSON.stringify({ event: "account_email_delivery_unconfigured" }),
			);
			throw new Error("Account email delivery is unavailable.");
		}

		const send = async () => {
			const [{ render }, { Resend }, { AccountActionEmail }] =
				await Promise.all([
					import("@react-email/render"),
					import("resend"),
					import("../lib/emails/account-action-email"),
				]);
			const content = {
				"verify-email": {
					preview: "Verify your RelayAPI email address",
					title: "Verify your email",
					message:
						"Confirm this email address to finish creating your RelayAPI account.",
					actionLabel: "Verify email",
					expiresIn: "one hour",
					subject: "Verify your RelayAPI email",
				},
				"reset-password": {
					preview: "Reset your RelayAPI password",
					title: "Reset your password",
					message: "Use this secure link to choose a new RelayAPI password.",
					actionLabel: "Reset password",
					expiresIn: "one hour",
					subject: "Reset your RelayAPI password",
				},
				"delete-account": {
					preview: "Confirm deletion of your RelayAPI account",
					title: "Confirm account deletion",
					message:
						"Confirm that you want to permanently delete your RelayAPI account.",
					actionLabel: "Delete my account",
					expiresIn: "30 minutes",
					subject: "Confirm RelayAPI account deletion",
				},
			}[data.kind];
			const html = await render(
				AccountActionEmail({
					...content,
					actionUrl: data.url,
				}),
			);
			const tokenDigest = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(data.token),
					),
				),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const { error } = await new Resend(cfEnv.RESEND_API_KEY).emails.send(
				{
					from: "RelayAPI <notifications@relayapi.dev>",
					to: data.email,
					subject: content.subject,
					html,
				},
				{ idempotencyKey: `account:${data.kind}:${tokenDigest}` },
			);
			if (error) {
				throw new Error(
					`Account email provider rejected request: ${error.name}`,
				);
			}
			console.info(
				JSON.stringify({ event: "account_email_sent", kind: data.kind }),
			);
		};

		try {
			await send();
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "account_email_failed",
					kind: data.kind,
					error: error instanceof Error ? error.name : "UnknownError",
				}),
			);
			throw new Error("Account email delivery failed.");
		}
	};
}

type KVNamespace = App.Locals["kv"];
type WaitUntil = (promise: Promise<unknown>) => void;

const ORG_SUMMARY_CACHE_PREFIX = "org-summary:";
const ORG_SUMMARY_TTL_S = 10 * 60;

async function getOrganizationSummary(
	db: Database,
	kv: KVNamespace | undefined,
	waitUntil: WaitUntil | undefined,
	organizationId: string,
): Promise<OrganizationSummary | null> {
	const cacheKey = `${ORG_SUMMARY_CACHE_PREFIX}${organizationId}`;

	if (kv) {
		try {
			const cached = await kv.get(cacheKey);
			if (cached) return JSON.parse(cached) as OrganizationSummary;
		} catch {
			// KV read failure is non-fatal — fall through to DB.
		}
	}

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

	const summary: OrganizationSummary = {
		id: org.id,
		name: org.name,
		slug: org.slug,
		logo: org.logo,
	};

	if (kv) {
		const writePromise = kv
			.put(cacheKey, JSON.stringify(summary), {
				expirationTtl: ORG_SUMMARY_TTL_S,
			})
			.catch(() => {
				// KV write failure is non-fatal.
			});

		if (waitUntil) {
			waitUntil(writePromise);
		}
	}

	return summary;
}

async function userHasOrganizations(
	db: Database,
	userId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: member.id })
		.from(member)
		.where(eq(member.userId, userId))
		.limit(1);

	return rows.length > 0;
}

/**
 * Authoritative membership check. better-auth's removeMember does not revoke
 * the removed user's session or clear their `activeOrganizationId`, so a stale
 * session (or the signed cookie cache used for internal /api/* routes) can keep
 * pointing at an org the user no longer belongs to. We re-verify membership on
 * every request that resolves an organization so removed members lose access
 * immediately instead of for the lifetime of their session.
 */
async function getOrganizationMembershipRole(
	db: Database,
	userId: string,
	organizationId: string,
): Promise<string | null> {
	const rows = await db
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.userId, userId), eq(member.organizationId, organizationId)),
		)
		.limit(1);

	return rows[0]?.role ?? null;
}

async function userHasPendingInvitations(
	db: Database,
	email: string,
): Promise<boolean> {
	const pending = await db
		.select({ id: invitation.id })
		.from(invitation)
		.where(and(eq(invitation.email, email), eq(invitation.status, "pending")))
		.limit(1);

	return pending.length > 0;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const path = context.url.pathname;
	const cfEnv: CfEnv = env;
	const productionAppOrigin =
		cfEnv.BETTER_AUTH_URL?.trim() || DEFAULT_PRODUCTION_APP_ORIGIN;
	if (import.meta.env.PROD && context.url.protocol === "http:") {
		const secureUrl = `${productionAppOrigin}${context.url.pathname}${context.url.search}`;
		return applyAppSecurityHeaders(Response.redirect(secureUrl, 308), true);
	}

	if (isStaticAssetPath(path)) {
		return applyAppSecurityHeaders(await next(), import.meta.env.PROD);
	}

	const publicAppOrigin =
		cfEnv.BETTER_AUTH_URL?.trim() ||
		(import.meta.env.PROD ? productionAppOrigin : context.url.origin);
	const remoteDashboardOrigin = resolveRemoteDashboardOrigin(
		cfEnv.REMOTE_DASHBOARD_ORIGIN,
		import.meta.env.DEV,
	);
	if (remoteDashboardOrigin && path.startsWith("/api/")) {
		try {
			return applyAppSecurityHeaders(
				await proxyRemoteDashboardRequest(
					context.request,
					remoteDashboardOrigin,
				),
				import.meta.env.PROD,
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "remote_dashboard_proxy_failed",
					error: error instanceof Error ? error.name : "UnknownError",
				}),
			);
			return applyAppSecurityHeaders(
				Response.json(
					{
						error: {
							code: "REMOTE_DASHBOARD_UNAVAILABLE",
							message: "The remote dashboard is unavailable.",
						},
					},
					{ status: 502 },
				),
				import.meta.env.PROD,
			);
		}
	}

	let db: Database | undefined;
	let auth: AuthInstance | undefined;
	const cfContext = (
		context.locals as { cfContext?: { waitUntil?: WaitUntil } }
	).cfContext;
	const waitUntil = cfContext?.waitUntil?.bind(cfContext);
	let authHeaders: Headers | null = null;
	let user: AuthUser | null = null;
	let session: AuthSessionRecord | null = null;
	let organization: OrganizationSummary | null = null;
	let organizationMembershipRole: string | null = null;
	let remoteContext: RemoteDashboardContext | null = null;

	const getDb = () => {
		if (remoteDashboardOrigin) {
			throw new Error(
				"Database access is disabled while using the remote dashboard backend",
			);
		}
		if (!db) {
			const connectionString =
				cfEnv.HYPERDRIVE?.connectionString || cfEnv.DATABASE_URL;
			db = createDb(connectionString);
		}
		return db;
	};

	const getAuth = () => {
		if (!auth) {
			const selfHosted = isSelfHostedDeployment(cfEnv);
			const selfHostedEmailEnabled =
				selfHosted && cfEnv.SELF_HOSTED_FEATURE_EMAIL === "1";
			auth = createAuth(getDb(), {
				BETTER_AUTH_SECRET: cfEnv.BETTER_AUTH_SECRET,
				BETTER_AUTH_URL: publicAppOrigin,
				GOOGLE_CLIENT_ID: cfEnv.GOOGLE_CLIENT_ID,
				GOOGLE_CLIENT_SECRET: cfEnv.GOOGLE_CLIENT_SECRET,
				sendInvitationEmail:
					!selfHosted || selfHostedEmailEnabled
						? createInvitationEmailSender(cfEnv, publicAppOrigin)
						: undefined,
				requireInvitationForSignUp: true,
				requireEmailVerification: !selfHosted || selfHostedEmailEnabled,
				sendAccountEmail:
					!selfHosted || selfHostedEmailEnabled
						? createAccountEmailSender(cfEnv)
						: undefined,
				afterRemoveMember: ({ userId, organizationId }) =>
					revokeDashboardPrincipal(getDb(), cfEnv.KV, organizationId, userId),
				deleteUserAtomically: ({ userId }) =>
					deleteUserAtomically(getDb(), cfEnv.KV, userId),
			});
		}
		return auth;
	};

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

	if (cfEnv.KV) {
		context.locals.kv = cfEnv.KV;
	}

	const finalize = (response: Response) => {
		mergeHeaders(response.headers, authHeaders);

		const contentType = response.headers.get("Content-Type") || "";
		if (contentType.includes("text/html")) {
			response.headers.set(
				"Cache-Control",
				"no-cache, no-store, must-revalidate",
			);
		}

		return applyAppSecurityHeaders(response, import.meta.env.PROD);
	};

	if (shouldResolveSession(path)) {
		if (remoteDashboardOrigin) {
			try {
				const result = await fetchRemoteDashboardContext(
					context.request,
					remoteDashboardOrigin,
				);
				remoteContext = result.context;
				authHeaders = result.cookieHeaders;
				if (remoteContext) {
					user = remoteContext.user as AuthUser;
					session = remoteContext.session as AuthSessionRecord;
					organization =
						remoteContext.organization as OrganizationSummary | null;
					organizationMembershipRole = remoteContext.organizationMembershipRole;
				}
			} catch (error) {
				// Fail closed: an unavailable or malformed remote session must never
				// become an authenticated local dashboard request.
				console.error(
					JSON.stringify({
						event: "remote_dashboard_session_resolution_failed",
						error: error instanceof Error ? error.name : "UnknownError",
					}),
				);
			}
		} else {
			let sessionState: SessionState | null = null;

			// Fast path: resolve the session from the signed cookie cache (HMAC
			// verify, no DB round trip or auth-instance construction) for ALL
			// session-resolving paths, including /app/* page views. The fallback
			// to getSession() below still runs whenever the 5-minute cookie cache
			// is absent or expired, preserving cookie refresh and revocation.
			if (
				cfEnv.BETTER_AUTH_SECRET &&
				!requiresAuthoritativeSession(context.url)
			) {
				const cached = (await getCookieCache(context.request, {
					secret: cfEnv.BETTER_AUTH_SECRET,
				})) as SessionState | null;
				if (cached) sessionState = cached;
			}

			if (!sessionState) {
				const sessionResult = (await getAuth().api.getSession({
					headers: context.request.headers,
					query: {
						disableCookieCache: requiresAuthoritativeSession(context.url),
					},
					returnHeaders: true,
				})) as {
					headers?: Headers | null;
					response: SessionState | null;
				};
				authHeaders = sessionResult.headers ?? null;
				sessionState = sessionResult.response;
			}

			if (sessionState) {
				user = sessionState.user;
				session = sessionState.session;

				const activeOrganizationId = session.activeOrganizationId ?? null;
				if (activeOrganizationId) {
					// SECURITY: re-verify the user is still a member of the active org.
					// The session (and the signed cookie cache for internal /api/* routes)
					// can outlive a removeMember, so trusting activeOrganizationId blindly
					// lets a removed member keep reading/writing the org's tenant data.
					const membershipRole = await getOrganizationMembershipRole(
						getDb(),
						user.id,
						activeOrganizationId,
					);

					if (membershipRole) {
						organizationMembershipRole = membershipRole;
						organization = {
							id: activeOrganizationId,
							name: null,
							slug: null,
							logo: null,
						};

						if (shouldLoadOrganizationSummary(path)) {
							organization =
								(await getOrganizationSummary(
									getDb(),
									cfEnv.KV,
									waitUntil,
									activeOrganizationId,
								)) ?? organization;
						}
					}
				}
			}
		}
	}

	context.locals.user = user;
	context.locals.session = session;
	context.locals.organization = organization;
	context.locals.organizationMembershipRole = organizationMembershipRole;

	const redirect = (location: string) => finalize(context.redirect(location));

	const isProtectedPath = PROTECTED_PATHS.some((prefix) =>
		path.startsWith(prefix),
	);

	if (isProtectedPath && !user) {
		return redirect(`/login?redirect=${encodeURIComponent(path)}`);
	}

	if (user && path.startsWith("/app/admin") && user.role !== "admin") {
		return redirect("/app");
	}

	// Use the authoritative membership result, not only the signed session's
	// activeOrganizationId. Its five-minute cookie cache can still name an
	// organization that was just deleted or that the user was removed from.
	if (user && shouldCheckOnboarding(path) && !organization) {
		const [hasOrganizations, hasPendingInvitations] = remoteDashboardOrigin
			? [
					remoteContext?.hasOrganizations ?? false,
					remoteContext?.hasPendingInvitations ?? false,
				]
			: await Promise.all([
					userHasOrganizations(getDb(), user.id),
					userHasPendingInvitations(getDb(), user.email),
				]);

		if (!hasOrganizations) {
			if (hasPendingInvitations) {
				return redirect("/app/invitations");
			}

			return redirect("/app/onboarding");
		}
	}

	if (user && path === "/app/onboarding" && organization) {
		return redirect("/app");
	}

	if (user && AUTH_PAGES.has(path)) {
		const redirectParam = normalizeAuthRedirect(
			context.url.searchParams.get("redirect"),
			"/app",
		);
		if (redirectParam?.startsWith("/invite/")) {
			return redirect(redirectParam);
		}

		return redirect("/app");
	}

	return finalize(await next());
});
