import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.ads.getAnalytics(ctx.params.id!, {
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      breakdowns: url.searchParams.get("breakdowns") || undefined,
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
