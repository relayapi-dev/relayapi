import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const data = await client.signatures.get(id);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const body = await ctx.request.json();
    const data = await client.signatures.update(id, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    await client.signatures.delete(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
