import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
    const data = await client.accounts.health.list({ cursor, limit });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
