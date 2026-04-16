import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.ads.listAccounts({
      social_account_id: url.searchParams.get("social_account_id") || undefined,
      workspace_id: url.searchParams.get("workspace_id") || undefined,
      q: url.searchParams.get("q") || undefined,
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit")) || 20,
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
