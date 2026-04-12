import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    await client.post("/v1/inbox/bulk", {
      body: { action: "mark_read", targets: [ctx.params.id!] },
    });
    return Response.json({ success: true });
  } catch (e) {
    return handleSdkError(e);
  }
};
