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

const PROTECTED_PATHS = ["/app"];
const AUTH_PAGES = new Set(["/login", "/signup"]);
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

function isInternalApiPath(path: string): boolean {
	return path.startsWith("/api/") && !path.startsWith("/api/auth/");
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
	cfEnv: Record<string, any>,
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
			console.log(`[Email] Enqueued invitation email to ${data.email}`);
			return;
		}

		if (cfEnv.RESEND_API_KEY) {
			const resend = new Resend(cfEnv.RESEND_API_KEY);
			await resend.emails.send({
				from: emailMessage.from,
				to: emailMessage.to,
				subject: emailMessage.subject,
				html: emailMessage.html,
			});
			console.log(`[Email] Sent invitation email directly to ${data.email}`);
			return;
		}

		console.warn(
			`[Email] No EMAIL_QUEUE or RESEND_API_KEY — invitation email to ${data.email} skipped`,
		);
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

	if (isStaticAssetPath(path)) {
		return next();
	}

	const cfEnv = env as Record<string, any>;
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

	const getDb = () => {
		if (!db) {
			const connectionString =
				cfEnv.HYPERDRIVE?.connectionString || cfEnv.DATABASE_URL;
			db = createDb(connectionString);
		}
		return db;
	};

	const getAuth = () => {
		if (!auth) {
			auth = createAuth(getDb(), {
				BETTER_AUTH_SECRET: cfEnv.BETTER_AUTH_SECRET,
				BETTER_AUTH_URL: cfEnv.BETTER_AUTH_URL || context.url.origin,
				GOOGLE_CLIENT_ID: cfEnv.GOOGLE_CLIENT_ID,
				GOOGLE_CLIENT_SECRET: cfEnv.GOOGLE_CLIENT_SECRET,
				sendInvitationEmail: createInvitationEmailSender(
					cfEnv,
					cfEnv.BETTER_AUTH_URL || context.url.origin,
				),
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

		return response;
	};

	if (shouldResolveSession(path)) {
		let sessionState: SessionState | null = null;

		if (isInternalApiPath(path)) {
			const cached = (await getCookieCache(context.request, {
				secret: cfEnv.BETTER_AUTH_SECRET,
			})) as SessionState | null;
			if (cached) sessionState = cached;
		}

		if (!sessionState) {
			const sessionResult = (await getAuth().api.getSession({
				headers: context.request.headers,
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

	context.locals.user = user;
	context.locals.session = session;
	context.locals.organization = organization;

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

	if (user && shouldCheckOnboarding(path) && !session?.activeOrganizationId) {
		const db = getDb();
		const [hasOrganizations, hasPendingInvitations] = await Promise.all([
			userHasOrganizations(db, user.id),
			userHasPendingInvitations(db, user.email),
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
		const redirectParam = context.url.searchParams.get("redirect");
		if (redirectParam?.startsWith("/invite/")) {
			return redirect(redirectParam);
		}

		return redirect("/app");
	}

	return finalize(await next());
});
