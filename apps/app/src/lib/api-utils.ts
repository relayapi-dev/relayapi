import { member } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type Relay from "@relayapi/sdk";
import { API_BASE_URL } from "./api-base-url";
import { getRelayClient } from "./relay";

const BILLING_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Return a 401/403 Response if the current user isn't an owner/admin of the
 * active organization. Returns null when authorized. Use at the top of any
 * billing / subscription mutation route.
 */
export async function requireBillingAdmin(
  ctx: { locals: App.Locals },
): Promise<Response | null> {
  const user = ctx.locals.user as { id: string } | null | undefined;
  const org = ctx.locals.organization as { id: string } | null | undefined;
  if (!user || !org) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const db = ctx.locals.db;
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, user.id), eq(member.organizationId, org.id)))
    .limit(1);

  if (!row || !BILLING_ADMIN_ROLES.has(row.role ?? "")) {
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Only organization admins can manage billing.",
        },
      },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Get the SDK client from an Astro API context, or return an error Response.
 */
export async function requireClient(
  ctx: { locals: App.Locals },
): Promise<Relay | Response> {
  if (!ctx.locals.user || !ctx.locals.organization) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const client = await getRelayClient(ctx.locals, API_BASE_URL);
  if (!client) {
    return Response.json(
      { error: { code: "NO_API_KEY", message: "No dashboard API key found. Please create one." } },
      { status: 500 },
    );
  }

  return client;
}

/**
 * Convert SDK errors into JSON responses.
 */
export function handleSdkError(err: unknown): Response {
  console.error("SDK error:", err);

  if (err && typeof err === "object" && "status" in err) {
    const apiErr = err as { status: number; message?: string; error?: any };

    // Preserve specific error codes from the backend (e.g. FREE_LIMIT_REACHED)
    // SDK error.error is the JSON body: { error: { code, message } }
    let code = "API_ERROR";
    let message = apiErr.message || "API error";
    const body = apiErr.error as any;
    if (body?.error?.code) {
      code = body.error.code;
      message = body.error.message || message;
    } else if (body?.code) {
      code = body.code;
      message = body.message || message;
    } else if (typeof body === "string") {
      message = body;
    } else if (body?.error?.name === "ZodError") {
      // Hono's zod-openapi validation errors come through as
      // { success: false, error: { name: "ZodError", message: "<JSON array>" } }.
      // Parse the message and surface the first issue in a readable form.
      code = "VALIDATION_ERROR";
      try {
        const issues = JSON.parse(body.error.message);
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
        message = body.error.message || "Validation failed";
      }
    }

    return Response.json(
      { error: { code, message } },
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
          : message,
      },
    },
    { status: 502 },
  );
}
