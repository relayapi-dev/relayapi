import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = ctx.params.id!;
    const mediaId = ctx.params.media_id!;
    await client.ideas.deleteMedia(id, mediaId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
