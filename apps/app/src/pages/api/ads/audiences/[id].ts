import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await (client as any).get(`/v1/ads/audiences/${ctx.params.id}`);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    await (client as any).delete(`/v1/ads/audiences/${ctx.params.id}`);
    return Response.json({ message: "Audience deleted" });
  } catch (e) {
    return handleSdkError(e);
  }
};
