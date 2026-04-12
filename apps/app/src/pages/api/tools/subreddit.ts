import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.tools.validate.retrieveSubreddit({
      name: url.searchParams.get("name") || "",
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
