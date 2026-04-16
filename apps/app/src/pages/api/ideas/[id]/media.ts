import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const id = ctx.params.id!;
    const body = await ctx.request.formData();
    const file = body.get("file") as File | null;
    if (!file) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "Missing file field" } },
        { status: 400 },
      );
    }
    const alt = body.get("alt") as string | null;
    const data = await client.ideas.uploadMedia(id, {
      file,
      alt: alt ?? undefined,
    });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
