import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await (client as any).get("/v1/ads/audiences", {
      query: {
        ad_account_id: url.searchParams.get("ad_account_id") || undefined,
        cursor: url.searchParams.get("cursor") || undefined,
        limit: Number(url.searchParams.get("limit")) || 20,
      },
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await (client as any).post("/v1/ads/audiences", { body });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
