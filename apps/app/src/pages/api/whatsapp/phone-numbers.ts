import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    const data = await client.whatsapp.listPhoneNumbers({
      account_id: url.searchParams.get("account_id") || "",
    });
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
