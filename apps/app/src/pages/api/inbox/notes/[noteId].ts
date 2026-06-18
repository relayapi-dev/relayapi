import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const user = ctx.locals.user as { id: string } | null | undefined;
  if (!user) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }
  const noteId = requireParam(ctx.params, "noteId");
  if (noteId instanceof Response) return noteId;
  try {
    const body = (await ctx.request.json()) as { text?: string };
    if (!body.text || !body.text.trim()) {
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "text is required" } },
        { status: 400 },
      );
    }
    const data = await client.inbox.conversations.updateNote(
      noteId,
      { text: body.text, user_id: user.id },
    );
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  const user = ctx.locals.user as { id: string } | null | undefined;
  if (!user) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }
  const noteId = requireParam(ctx.params, "noteId");
  if (noteId instanceof Response) return noteId;
  try {
    const data = await client.inbox.conversations.deleteNote(
      noteId,
      { user_id: user.id },
    );
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
