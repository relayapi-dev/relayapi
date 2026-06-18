import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    await client.inbox.conversations.markRead({ targets: [id] });
    return Response.json({ success: true });
  } catch (e) {
    return handleSdkError(e);
  }
};
