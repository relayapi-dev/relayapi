import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.sequences.list();
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.sequences.create(body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
