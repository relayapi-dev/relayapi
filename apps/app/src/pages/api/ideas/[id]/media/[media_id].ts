import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  const mediaId = requireParam(ctx.params, "media_id");
  if (mediaId instanceof Response) return mediaId;
  try {
    await client.ideas.deleteMedia(id, mediaId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
