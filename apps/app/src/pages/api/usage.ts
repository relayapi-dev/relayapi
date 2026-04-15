import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.usage.retrieve();
    return Response.json({
      plan: data.plan.name,
      api_calls: {
        used: data.usage.api_calls_used,
        included: data.plan.api_calls_limit,
      },
      period_start: data.usage.cycle_start,
      period_end: data.usage.cycle_end,
    }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e: any) {
    const headers = e?.headers as Headers | undefined;
    const usageCount = headers?.get("x-usage-count");
    const usageLimit = headers?.get("x-usage-limit");

    if (usageCount != null && usageLimit != null) {
      return Response.json({
        plan: "free",
        api_calls: {
          used: Number(usageCount),
          included: Number(usageLimit),
        },
      });
    }

    const body = e?.error;
    const code = body?.error?.code || body?.code;
    if (code === "FREE_LIMIT_REACHED") {
      const msg = body?.error?.message || body?.message || e?.message || "";
      const match = msg.match(/\((\d+)/);
      const limit = match ? Number(match[1]) : 200;
      return Response.json({
        plan: "free",
        api_calls: {
          used: limit,
          included: limit,
        },
      });
    }

    return handleSdkError(e);
  }
};
