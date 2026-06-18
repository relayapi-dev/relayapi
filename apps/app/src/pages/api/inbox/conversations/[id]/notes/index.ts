import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const data = await client.inbox.conversations.listNotes(id);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const user = ctx.locals.user as { id: string } | null | undefined;
  if (!user) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }
  const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    const body = (await ctx.request.json()) as { text?: string };
    if (!body.text || !body.text.trim()) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "text is required" } },
        { status: 400 },
      );
    }
    const data = await client.inbox.conversations.createNote(id, {
      text: body.text,
      user_id: user.id,
    });
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
