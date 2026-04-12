import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.get("/v1/org-settings");
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
    const data = await client.patch("/v1/org-settings", { body });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
