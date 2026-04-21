import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const PUT: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const body = await ctx.request.json();
		const data = await client.automations.updateGraph(id, body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
