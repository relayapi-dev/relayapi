import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    // GET /v1/analytics now defaults to limit=20; the dashboard analytics view
    // expects the full per-account target set, so request the schema max (100).
    const data = await client.analytics.retrieve({
      account_id: url.searchParams.get("account_id") || undefined,
      from_date: url.searchParams.get("from_date") || undefined,
      to_date: url.searchParams.get("to_date") || undefined,
      limit: 100,
    });
    return Response.json(data, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (e) {
    return handleSdkError(e);
  }
};
