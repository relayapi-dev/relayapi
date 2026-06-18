import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  const commentId = requireParam(ctx.params, "comment_id");
  if (commentId instanceof Response) return commentId;
  try {
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
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  const commentId = requireParam(ctx.params, "comment_id");
  if (commentId instanceof Response) return commentId;
  try {
    await client.ideas.deleteComment(id, commentId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
