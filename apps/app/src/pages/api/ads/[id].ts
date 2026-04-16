import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.ads.retrieve(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.ads.update(ctx.params.id!, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    await client.ads.delete(ctx.params.id!);
    return Response.json({ message: "Ad cancelled" });
  } catch (e) {
    return handleSdkError(e);
  }
};
