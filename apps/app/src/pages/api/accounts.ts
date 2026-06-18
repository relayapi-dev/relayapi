import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const params: Record<string, string | number | boolean | undefined> = {
      limit: Number(url.searchParams.get("limit")) || 20,
      cursor: url.searchParams.get("cursor") || undefined,
    };
    const workspaceId = url.searchParams.get("workspace_id");
    if (workspaceId) {
      params.workspace_id = workspaceId;
    }
    if (url.searchParams.get("ungrouped") === "true") {
      params.ungrouped = true;
    }
    const search = url.searchParams.get("search");
    if (search) {
      params.search = search;
    }
    const platforms = url.searchParams.get("platforms");
    if (platforms) {
      params.platforms = platforms;
    }
    const data = await client.accounts.list(params);
    return Response.json(data, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (e) {
    return handleSdkError(e);
  }
};
