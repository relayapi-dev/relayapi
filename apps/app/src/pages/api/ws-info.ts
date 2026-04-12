import type { APIRoute } from "astro";
import { getDashboardApiKey } from "@/lib/relay";

const API_BASE_URL =
  import.meta.env.API_BASE_URL ||
  (import.meta.env.DEV ? "http://localhost:8789" : "https://api.relayapi.dev");

/**
 * Returns the WebSocket connection URL and token for the authenticated user's org.
 * The client uses this to connect directly to the API worker's WS endpoint.
 */
export const GET: APIRoute = async (ctx) => {
  if (!ctx.locals.user || !ctx.locals.organization) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const orgId = (ctx.locals.organization as any).id as string;
  const apiKey = await getDashboardApiKey(ctx.locals.kv, orgId);
  if (!apiKey) {
    return Response.json(
      { error: { code: "NO_API_KEY", message: "No dashboard API key found" } },
      { status: 500 },
    );
  }

  // Convert http(s) to ws(s) for WebSocket URL
  const wsUrl = API_BASE_URL.replace(/^http/, "ws") + "/v1/ws";

  return Response.json(
    { url: wsUrl, token: apiKey },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
};
