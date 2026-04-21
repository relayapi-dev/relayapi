import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const data = await client.automationEntrypoints.list(id);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const body = await ctx.request.json();
		const data = await client.automationEntrypoints.create(id, body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
