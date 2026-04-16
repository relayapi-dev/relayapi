import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const source = url.searchParams.get("source");
    const data = await client.ads.list({
      campaign_id: url.searchParams.get("campaign_id") || undefined,
      platform: url.searchParams.get("platform") || undefined,
      status: url.searchParams.get("status") || undefined,
      workspace_id: url.searchParams.get("workspace_id") || undefined,
      source: source === "internal" || source === "external" || source === "all" ? source : undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || 20,
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
    const data = await client.ads.create(body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
