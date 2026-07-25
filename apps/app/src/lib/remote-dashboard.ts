const DEFAULT_REMOTE_DASHBOARD_ORIGIN = "https://relayapi.dev";
const REMOTE_CONTEXT_PATH = "/api/dashboard-context";

type RemoteUser = Record<string, unknown> & {
	id: string;
	email: string;
};

type RemoteSession = Record<string, unknown> & {
	id: string;
	userId: string;
};

type RemoteOrganization = Record<string, unknown> & {
	id: string;
};

export interface RemoteDashboardContext {
	user: RemoteUser;
	session: RemoteSession;
	organization: RemoteOrganization | null;
	organizationMembershipRole: string | null;
	hasOrganizations: boolean;
	hasPendingInvitations: boolean;
}

export interface RemoteDashboardContextResult {
	context: RemoteDashboardContext | null;
	cookieHeaders: Headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemoteDashboardContext(
	value: unknown,
): value is RemoteDashboardContext {
	if (!isRecord(value)) return false;
	if (!isRecord(value.user) || typeof value.user.id !== "string") return false;
	if (typeof value.user.email !== "string") return false;
	if (!isRecord(value.session) || typeof value.session.id !== "string") {
		return false;
	}
	if (typeof value.session.userId !== "string") return false;
	if (
		value.organization !== null &&
		(!isRecord(value.organization) || typeof value.organization.id !== "string")
	) {
		return false;
	}
	if (
		value.organizationMembershipRole !== null &&
		typeof value.organizationMembershipRole !== "string"
	) {
		return false;
	}
	return (
		typeof value.hasOrganizations === "boolean" &&
		typeof value.hasPendingInvitations === "boolean"
	);
}

function appendSetCookieHeaders(target: Headers, source: Headers): void {
	const getSetCookie = (source as Headers & { getSetCookie?: () => string[] })
		.getSetCookie;
	if (typeof getSetCookie === "function") {
		for (const cookie of getSetCookie.call(source)) {
			target.append("set-cookie", cookie);
		}
		return;
	}

	const cookie = source.get("set-cookie");
	if (cookie) target.append("set-cookie", cookie);
}

function responseHeadersForProxy(source: Headers): Headers {
	const headers = new Headers();
	for (const [name, value] of source.entries()) {
		const normalized = name.toLowerCase();
		if (normalized === "set-cookie" || normalized === "content-length") {
			continue;
		}
		headers.append(name, value);
	}
	appendSetCookieHeaders(headers, source);
	return headers;
}

/**
 * Local Astro development delegates dashboard auth and BFF routes to the
 * deployed dashboard. Production builds always return null, even if a stale
 * local variable is accidentally present in the deployment environment.
 */
export function resolveRemoteDashboardOrigin(
	configuredValue: string | undefined,
	isDevelopment: boolean,
): string | null {
	if (!isDevelopment) return null;

	const configured = configuredValue?.trim();
	if (configured?.toLowerCase() === "off") return null;

	const url = new URL(configured || DEFAULT_REMOTE_DASHBOARD_ORIGIN);
	if (url.protocol !== "https:") {
		throw new Error("REMOTE_DASHBOARD_ORIGIN must use HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("REMOTE_DASHBOARD_ORIGIN must not contain credentials");
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error("REMOTE_DASHBOARD_ORIGIN must be an origin without a path");
	}

	return url.origin;
}

function upstreamRequestHeaders(
	request: Request,
	remoteOrigin: string,
): Headers {
	const headers = new Headers(request.headers);
	for (const name of [
		"host",
		"content-length",
		"x-forwarded-for",
		"x-forwarded-host",
		"x-forwarded-proto",
		"cf-connecting-ip",
		"cf-ray",
	]) {
		headers.delete(name);
	}

	// Better Auth validates state-changing browser requests against Origin.
	// The local HTTPS origin is trusted by the developer proxy, while the
	// deployed app must continue to see its own reviewed public origin.
	if (headers.has("origin")) headers.set("origin", remoteOrigin);
	if (headers.has("referer")) {
		const requestUrl = new URL(request.url);
		headers.set(
			"referer",
			`${remoteOrigin}${requestUrl.pathname}${requestUrl.search}`,
		);
	}

	// Avoid a server-fetch implementation transparently decoding a body while
	// retaining the upstream Content-Encoding header in the proxied response.
	headers.set("accept-encoding", "identity");
	return headers;
}

function publicRequestOrigin(request: Request): string {
	const url = new URL(request.url);
	const forwardedProtocol = request.headers.get("x-forwarded-proto");
	if (forwardedProtocol === "https" || forwardedProtocol === "http") {
		url.protocol = `${forwardedProtocol}:`;
	}
	return url.origin;
}

export async function proxyRemoteDashboardRequest(
	request: Request,
	remoteOrigin: string,
): Promise<Response> {
	const incomingUrl = new URL(request.url);
	const localOrigin = publicRequestOrigin(request);
	const browserOrigin = request.headers.get("origin");
	if (browserOrigin && new URL(browserOrigin).origin !== localOrigin) {
		return Response.json(
			{
				error: {
					code: "INVALID_ORIGIN",
					message: "Cross-origin development proxy requests are not allowed.",
				},
			},
			{ status: 403 },
		);
	}
	const upstreamUrl = new URL(
		`${incomingUrl.pathname}${incomingUrl.search}`,
		remoteOrigin,
	);
	const upstreamResponse = await fetch(upstreamUrl, {
		method: request.method,
		headers: upstreamRequestHeaders(request, remoteOrigin),
		body:
			request.method === "GET" || request.method === "HEAD"
				? undefined
				: request.body,
		redirect: "manual",
	});
	const headers = responseHeadersForProxy(upstreamResponse.headers);
	const location = headers.get("location");
	if (location) {
		const locationUrl = new URL(location, remoteOrigin);
		if (locationUrl.origin === remoteOrigin) {
			headers.set(
				"location",
				`${localOrigin}${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`,
			);
		}
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers,
	});
}

export async function fetchRemoteDashboardContext(
	request: Request,
	remoteOrigin: string,
): Promise<RemoteDashboardContextResult> {
	const headers = new Headers({
		Accept: "application/json",
		Origin: remoteOrigin,
	});
	const cookie = request.headers.get("cookie");
	if (cookie) headers.set("cookie", cookie);
	const userAgent = request.headers.get("user-agent");
	if (userAgent) headers.set("user-agent", userAgent);

	const contextUrl = new URL(REMOTE_CONTEXT_PATH, remoteOrigin);
	if (new URL(request.url).pathname.startsWith("/app/admin")) {
		contextUrl.searchParams.set("authoritative", "1");
	}
	const response = await fetch(contextUrl, {
		headers,
		cache: "no-store",
	});
	const cookieHeaders = new Headers();
	appendSetCookieHeaders(cookieHeaders, response.headers);

	if (response.status === 401) {
		return { context: null, cookieHeaders };
	}
	if (!response.ok) {
		throw new Error(`Remote dashboard context failed (${response.status})`);
	}

	const body: unknown = await response.json();
	if (!isRemoteDashboardContext(body)) {
		throw new Error("Remote dashboard returned an invalid context response");
	}

	return { context: body, cookieHeaders };
}
