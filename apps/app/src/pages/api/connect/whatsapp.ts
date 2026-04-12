import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.connect.whatsapp.getSDKConfig();
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
    if (body.embedded_signup) {
      const data = await client.connect.whatsapp.completeEmbeddedSignup(body);
      return Response.json(data);
    }
    const data = await client.connect.whatsapp.connectViaCredentials(body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
