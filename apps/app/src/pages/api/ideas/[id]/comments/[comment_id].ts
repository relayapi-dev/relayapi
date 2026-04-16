import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = ctx.params.id!;
    const commentId = ctx.params.comment_id!;
    const body = await ctx.request.json();
    const data = await client.ideas.updateComment(id, commentId, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = ctx.params.id!;
    const commentId = ctx.params.comment_id!;
    await client.ideas.deleteComment(id, commentId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
