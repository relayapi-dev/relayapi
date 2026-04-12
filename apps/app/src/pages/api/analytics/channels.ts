import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await (client as any).get("/v1/analytics/channels", {
      query: {
        from_date: url.searchParams.get("from_date") || undefined,
        to_date: url.searchParams.get("to_date") || undefined,
      },
    });
    return Response.json(data, { headers: { "Cache-Control": "private, max-age=0" } });
  } catch (e) {
    return handleSdkError(e);
  }
};
