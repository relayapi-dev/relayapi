import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.inbox.reviews.reply.create(ctx.params.id!, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.inbox.reviews.reply.delete(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
