import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
    const query: Record<string, string> = {};
    if (workspaceId) query.workspace_id = workspaceId;
    const data = await client.accounts.syncAll(query);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
