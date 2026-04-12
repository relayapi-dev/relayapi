import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    await client.sequences.unenroll(ctx.params.id!, ctx.params.enrollmentId!);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
