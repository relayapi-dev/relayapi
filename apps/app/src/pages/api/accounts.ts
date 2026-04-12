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
    if (url.searchParams.get("workspace_id")) {
      params.workspace_id = url.searchParams.get("workspace_id");
    }
    if (url.searchParams.get("ungrouped") === "true") {
      params.ungrouped = true;
    }
    if (url.searchParams.get("search")) {
      params.search = url.searchParams.get("search");
    }
    if (url.searchParams.get("platforms")) {
      params.platforms = url.searchParams.get("platforms");
    }
    const data = await client.accounts.list(params);
    return Response.json(data, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (e) {
    return handleSdkError(e);
  }
};
