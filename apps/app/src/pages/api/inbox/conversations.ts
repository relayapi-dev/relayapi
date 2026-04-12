import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const params: Record<string, any> = {
      limit: Number(url.searchParams.get("limit")) || 20,
      cursor: url.searchParams.get("cursor") || undefined,
    };
    if (url.searchParams.get("account_id")) params.account_id = url.searchParams.get("account_id");
    if (url.searchParams.get("status")) params.status = url.searchParams.get("status");
    if (url.searchParams.get("platform")) params.platform = url.searchParams.get("platform");
    if (url.searchParams.get("type")) params.type = url.searchParams.get("type");
    if (url.searchParams.get("labels")) params.labels = url.searchParams.get("labels");
    const data = await client.inbox.conversations.list(params);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
