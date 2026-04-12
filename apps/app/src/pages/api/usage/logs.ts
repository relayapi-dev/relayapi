import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const query: Record<string, string | number> = {
      limit: Number(url.searchParams.get("limit")) || 50,
    };
    const cursor = url.searchParams.get("cursor");
    if (cursor) query.cursor = cursor;
    const from = url.searchParams.get("from");
    if (from) query.from = from;
    const to = url.searchParams.get("to");
    if (to) query.to = to;

    // SDK doesn't have listLogs yet (auto-generated), use raw client GET
    const data = await (client as any).get("/v1/usage/logs", { query });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
