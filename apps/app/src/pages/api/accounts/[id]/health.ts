import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.accounts.health.retrieve(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
