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
    if (url.searchParams.get("workspace_id")) params.workspace_id = url.searchParams.get("workspace_id");
    const data = await client.media.list(params);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
