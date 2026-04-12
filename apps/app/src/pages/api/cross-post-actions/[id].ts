import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.crossPostActions.cancel(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
