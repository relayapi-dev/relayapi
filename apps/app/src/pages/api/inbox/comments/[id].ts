import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const params: Record<string, any> = {};
    if (url.searchParams.get("account_id")) params.account_id = url.searchParams.get("account_id");
    if (url.searchParams.get("platform")) params.platform = url.searchParams.get("platform");
    if (url.searchParams.get("cursor")) params.cursor = url.searchParams.get("cursor");
    if (url.searchParams.get("limit")) params.limit = Number(url.searchParams.get("limit"));
    const data = await client.inbox.comments.retrieve(ctx.params.id!, params);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.inbox.comments.delete(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
