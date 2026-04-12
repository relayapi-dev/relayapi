import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const params: Record<string, string> = {};
		for (const key of ["workspace_id", "search", "tag", "platform", "account_id", "limit", "cursor"]) {
			const val = url.searchParams.get(key);
			if (val) params[key] = val;
		}
		const data = await client.contacts.list(params as any);
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
		const data = await client.contacts.create(body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
