import type { APIRoute } from "astro";
import { getRelayClient } from "@/lib/relay";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const params: Record<string, any> = {
      limit: Number(url.searchParams.get("limit")) || 20,
      cursor: url.searchParams.get("cursor") || undefined,
    };
    if (url.searchParams.get("workspace_id")) params.workspace_id = url.searchParams.get("workspace_id");
    if (url.searchParams.get("account_id")) params.account_id = url.searchParams.get("account_id");
    if (url.searchParams.get("status")) params.status = url.searchParams.get("status");
    if (url.searchParams.get("from")) params.from = url.searchParams.get("from");
    if (url.searchParams.get("to")) params.to = url.searchParams.get("to");
    if (url.searchParams.get("include")) params.include = url.searchParams.get("include");
    if (url.searchParams.get("include_external")) params.include_external = url.searchParams.get("include_external");
    const data = await client.posts.list(params);
    return Response.json(data, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (e) {
    return handleSdkError(e);
  }
};

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.posts.create(body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
