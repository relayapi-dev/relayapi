import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = ctx.params.id!;
    const body = await ctx.request.json();
    const data = await client.ideas.move(id, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
