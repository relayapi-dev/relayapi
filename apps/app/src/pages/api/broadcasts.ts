import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.broadcasts.list({
      account_id: url.searchParams.get("account_id") || undefined,
      status: url.searchParams.get("status") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
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
    const data = await client.broadcasts.create(body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
