import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;

  const filename = ctx.url.searchParams.get("filename");
  if (!filename) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Missing filename query parameter" } },
      { status: 400 },
    );
  }

  try {
    const contentType = ctx.request.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await ctx.request.arrayBuffer();
    const data = await client.media.upload(arrayBuffer, { filename }, {
      headers: { "Content-Type": contentType },
    });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
