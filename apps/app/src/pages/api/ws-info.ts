import type { APIRoute } from "astro";
import { API_BASE_URL } from "@/lib/api-base-url";
import { getRelayClient } from "@/lib/relay";

/**
 * Returns the WebSocket connection URL and a short-lived ticket for the
 * authenticated user's org. The client uses this to connect directly to the
 * API worker's WS endpoint without exposing the raw API key on the URL.
 */
export const GET: APIRoute = async (ctx) => {
  if (!ctx.locals.user || !ctx.locals.organization) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const client = await getRelayClient(ctx.locals, API_BASE_URL);
  if (!client) {
    return Response.json(
      { error: { code: "NO_API_KEY", message: "No dashboard API key found" } },
      { status: 500 },
    );
  }

  const data = await client.wsTicket.retrieve();

  const wsUrl = API_BASE_URL.replace(/^http/, "ws") + "/v1/ws";

  return Response.json(
    { url: wsUrl, ticket: data.ticket, expires_at: data.expires_at },
    { headers: { "Cache-Control": "no-store" } },
  );
};
