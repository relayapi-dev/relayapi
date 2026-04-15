import type Relay from "@relayapi/sdk";
import { getRelayClient } from "./relay";

const API_BASE_URL =
  import.meta.env.API_BASE_URL ||
  (import.meta.env.DEV ? "http://localhost:8789" : "https://api.relayapi.dev");

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
