import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const action = url.searchParams.get("action");
    if (action === "search") {
      const data = await client.reddit.search({
        account_id: url.searchParams.get("account_id") || "",
        query: url.searchParams.get("query") || "",
      });
      return Response.json(data);
    }
    const data = await client.reddit.getFeed({
      account_id: url.searchParams.get("account_id") || "",
      subreddit: url.searchParams.get("subreddit") || "",
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
