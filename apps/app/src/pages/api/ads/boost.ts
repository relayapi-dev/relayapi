import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await (client as any).post("/v1/ads/boost", { body });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
