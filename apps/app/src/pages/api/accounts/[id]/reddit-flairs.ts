import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.accounts.redditFlairs.retrieve(id, {
      subreddit: url.searchParams.get("subreddit") || "",
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
