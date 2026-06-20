import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

// Daily API-call counts that power the Overview "API Calls" heatmap. Proxies the
// SDK `usage.timeseries` endpoint (server-side day aggregation of request logs).
export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;

  try {
    const url = new URL(ctx.request.url);
    const days = Number(url.searchParams.get("days")) || 365;
    const data = await client.usage.timeseries({ days });
    return Response.json(data, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return handleSdkError(e);
  }
};
