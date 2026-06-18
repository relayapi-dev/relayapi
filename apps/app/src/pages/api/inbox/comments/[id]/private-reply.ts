import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const body = await ctx.request.json();
    const data = await client.inbox.comments.privateReply(id, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
