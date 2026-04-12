import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const body = await ctx.request.json();
		const data = await client.workspaces.update(ctx.params.id!, body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		await client.workspaces.delete(ctx.params.id!);
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
