import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.whatsapp.businessProfile.retrieve({
      account_id: url.searchParams.get("account_id") || "",
    });
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
    const data = await client.whatsapp.businessProfile.update(body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
