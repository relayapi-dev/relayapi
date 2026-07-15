import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

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
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const body = (await ctx.request.json()) as { text?: string };
		if (!body.text?.trim()) {
			return Response.json(
				{ error: { code: "BAD_REQUEST", message: "text is required" } },
				{ status: 400 },
			);
		}
		const data = await client.inbox.conversations.createNote(id, {
			text: body.text,
		});
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
