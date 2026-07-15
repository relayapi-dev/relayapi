import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const noteId = requireParam(ctx.params, "noteId");
	if (noteId instanceof Response) return noteId;
	try {
		const body = (await ctx.request.json()) as { text?: string };
		if (!body.text?.trim()) {
			return Response.json(
				{ error: { code: "BAD_REQUEST", message: "text is required" } },
				{ status: 400 },
			);
		}
		const data = await client.inbox.conversations.updateNote(noteId, {
			text: body.text,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const noteId = requireParam(ctx.params, "noteId");
	if (noteId instanceof Response) return noteId;
	try {
		const data = await client.inbox.conversations.deleteNote(noteId);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
