import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const url = new URL(ctx.request.url);
    // GET /v1/whatsapp/broadcasts is now keyset-paginated (default limit 50).
    // Forward cursor/limit so the dashboard's usePaginatedApi can page through
    // and read next_cursor/has_more off the passthrough response. The param type
    // is derived from the client method so it stays correct once the generated
    // SDK adds cursor/limit, while the cast keeps this compile-clean until then.
    type ListParams = Parameters<typeof client.whatsapp.broadcasts.list>[0];
    const params: Record<string, unknown> = {
      account_id: url.searchParams.get("account_id") || "",
    };
    const cursor = url.searchParams.get("cursor");
    if (cursor) params.cursor = cursor;
    const limit = Number(url.searchParams.get("limit"));
    if (limit) params.limit = limit;
    const data = await client.whatsapp.broadcasts.list(
      params as unknown as ListParams,
    );
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
    const data = await client.whatsapp.broadcasts.create(body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
