import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = requireParam(ctx.params, "id");
    if (id instanceof Response) return id;
    const body = await ctx.request.json();
    const data = await client.ideas.convert(id, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
