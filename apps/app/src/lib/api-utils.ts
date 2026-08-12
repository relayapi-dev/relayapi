import { DASHBOARD_SESSION_AUTHORITY_HEADER } from "@relayapi/config";
import type Relay from "@relayapi/sdk";
import { API_BASE_URL } from "./api-base-url";
import { canManageOrganizationCredentials } from "./credential-authorization";
import {
	dashboardCredentialErrorResponse,
	ensureDashboardCredential,
} from "./dashboard-credential";
import { getRelayClient } from "./relay";

export async function requireOrganizationAdmin(
	ctx: { locals: App.Locals },
	message = "Only organization admins can perform this action.",
): Promise<Response | null> {
	const user = ctx.locals.user as { id: string } | null | undefined;
	const org = ctx.locals.organization as { id: string } | null | undefined;
	if (!user || !org) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}

	// Middleware resolves this role from the live member row on every request.
	// Do not fall back to the signed session's activeOrganizationId here.
	if (
		!canManageOrganizationCredentials(ctx.locals.organizationMembershipRole)
	) {
		return Response.json(
			{ error: { code: "FORBIDDEN", message } },
			{ status: 403 },
		);
	}
	return null;
}

export function requireOrganizationOwner(ctx: {
	locals: App.Locals;
}): Response | null {
	if (!ctx.locals.user || !ctx.locals.organization) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}
	const roles = (ctx.locals.organizationMembershipRole ?? "")
		.split(",")
		.map((role) => role.trim());
	if (roles.includes("owner")) return null;
	return Response.json(
		{
			error: {
				code: "FORBIDDEN",
				message: "Only the organization owner can delete this organization.",
			},
		},
		{ status: 403 },
	);
}

/**
 * Return a 401/403 Response if the current user isn't an owner/admin of the
 * active organization. Returns null when authorized. Use at the top of any
 * billing / subscription mutation route.
 */
export async function requireBillingAdmin(ctx: {
	locals: App.Locals;
}): Promise<Response | null> {
	return requireOrganizationAdmin(
		ctx,
		"Only organization admins can manage billing.",
	);
}

/**
 * Read a required route parameter (e.g. `[id]`) from an Astro API context.
 * Returns the value when present, or a 400 Response when missing. Astro only
 * matches the route when the segment is filled, so this is effectively an
 * invariant check that mirrors the previous non-null assertions.
 */
export function requireParam(
	params: Record<string, string | undefined>,
	name: string,
): string | Response {
	const value = params[name];
	if (!value) {
		return Response.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: `Missing ${name} parameter`,
				},
			},
			{ status: 400 },
		);
	}
	return value;
}

export function requireIdempotencyKey(request: Request): string | Response {
	const value = request.headers.get("Idempotency-Key")?.trim();
	if (!value || value.length > 255) {
		return Response.json(
			{
				error: {
					code: "IDEMPOTENCY_KEY_REQUIRED",
					message: "A valid Idempotency-Key header is required",
				},
			},
			{ status: 400 },
		);
	}
	return value;
}

/**
 * Get the SDK client from an Astro API context, or return an error Response.
 */
export async function requireClient(ctx: {
	locals: App.Locals;
}): Promise<Relay | Response> {
	if (!ctx.locals.user || !ctx.locals.organization) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}

	let client = await getRelayClient(ctx.locals, API_BASE_URL);
	if (!client) {
		const credential = await ensureDashboardCredential(ctx.locals);
		if (!credential.ok) {
			return dashboardCredentialErrorResponse(credential);
		}
		client = await getRelayClient(ctx.locals, API_BASE_URL);
	}
	if (!client) {
		return Response.json(
			{
				error: {
					code: "DASHBOARD_CREDENTIAL_UNAVAILABLE",
					message: "Dashboard credential could not be loaded.",
				},
			},
			{ status: 500 },
		);
	}

	return client;
}

export function dashboardSessionRequestOptions(
	locals: Pick<App.Locals, "session">,
): { headers: Record<string, string> } | null {
	const currentSession = locals.session as { id?: unknown } | null | undefined;
	if (typeof currentSession?.id !== "string" || !currentSession.id) return null;
	return {
		headers: {
			[DASHBOARD_SESSION_AUTHORITY_HEADER]: currentSession.id,
		},
	};
}

/**
 * Resolve a dashboard SDK client plus an exact-session locator derived only
 * from authoritative server locals. Capability-granting API transactions use
 * this header to lock the browser session that initiated the request.
 */
export async function requireSessionBoundClient(ctx: {
	locals: App.Locals;
}): Promise<
	| {
			client: Relay;
			requestOptions: { headers: Record<string, string> };
	  }
	| Response
> {
	const requestOptions = dashboardSessionRequestOptions(ctx.locals);
	if (!requestOptions) {
		return Response.json(
			{
				error: {
					code: "SESSION_NO_LONGER_AUTHORIZED",
					message: "Your session is no longer authorized.",
				},
			},
			{ status: 401 },
		);
	}

	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	return {
		client,
		requestOptions,
	};
}

/**
 * Convert SDK errors into JSON responses.
 */
export function handleSdkError(err: unknown): Response {
	const status =
		err && typeof err === "object" && "status" in err
			? Number((err as { status?: unknown }).status)
			: undefined;
	console.error("[dashboard-api] SDK request failed", {
		error_type: err instanceof Error ? err.name : typeof err,
		...(Number.isInteger(status) ? { status } : {}),
	});

	if (err && typeof err === "object" && "status" in err) {
		const apiErr = err as { status: number; message?: string; error?: unknown };

		// Preserve specific error codes from the backend (e.g. FREE_LIMIT_REACHED)
		// SDK error.error is the JSON body: { error: { code, message } }
		let code = "API_ERROR";
		let message = apiErr.message || "API error";
		let details: Record<string, unknown> | undefined;
		const body = apiErr.error as
			| string
			| {
					code?: string;
					message?: string;
					details?: Record<string, unknown>;
					error?: {
						code?: string;
						message?: string;
						name?: string;
						details?: Record<string, unknown>;
					};
			  }
			| undefined;
		const bodyObj = typeof body === "object" ? body : undefined;
		if (bodyObj?.error?.code) {
			code = bodyObj.error.code;
			message = bodyObj.error.message || message;
			details = bodyObj.error.details;
		} else if (bodyObj?.code) {
			code = bodyObj.code;
			message = bodyObj.message || message;
			details = bodyObj.details;
		} else if (typeof body === "string") {
			message = body;
		} else if (bodyObj?.error?.name === "ZodError") {
			// Hono's zod-openapi validation errors come through as
			// { success: false, error: { name: "ZodError", message: "<JSON array>" } }.
			// Parse the message and surface the first issue in a readable form.
			code = "VALIDATION_ERROR";
			try {
				const issues = JSON.parse(bodyObj.error.message ?? "");
				if (Array.isArray(issues) && issues.length > 0) {
					const first = issues[0] as {
						path?: Array<string | number>;
						message?: string;
					};
					const path = Array.isArray(first.path) ? first.path.join(".") : "";
					message = path
						? `${path}: ${first.message ?? "invalid value"}`
						: (first.message ?? "Validation failed");
				}
			} catch {
				message = bodyObj.error.message || "Validation failed";
			}
		}

		return Response.json(
			{ error: { code, message, ...(details ? { details } : {}) } },
			{ status: apiErr.status || 500 },
		);
	}

	const message = err instanceof Error ? err.message : "Unknown error";
	const isConnectionError =
		message.includes("fetch failed") ||
		message.includes("ECONNREFUSED") ||
		message.includes("ConnectionError");

	return Response.json(
		{
			error: {
				code: isConnectionError ? "API_UNREACHABLE" : "PROXY_ERROR",
				message: isConnectionError
					? "Cannot reach the API server. Make sure it is running."
					: "The API request could not be completed.",
			},
		},
		{ status: 502 },
	);
}
