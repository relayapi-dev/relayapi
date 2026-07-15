import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const { operation_id: operationId, ...body } = await ctx.request.json();
    if (typeof operationId !== "string" || !operationId) {
      return Response.json(
        { error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "operation_id is required" } },
        { status: 400 },
      );
    }
    const data = await client.ads.boost(body, { idempotencyKey: operationId });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
