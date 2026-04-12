import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await (client as any).post(`/v1/ads/accounts/${ctx.params.id}/sync`);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
