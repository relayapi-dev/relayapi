import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.automations.list({
			cursor: url.searchParams.get("cursor") || undefined,
			limit: Number(url.searchParams.get("limit")) || 20,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
			status: (url.searchParams.get("status") as never) || undefined,
			channel: (url.searchParams.get("channel") as never) || undefined,
			trigger_type: url.searchParams.get("trigger_type") || undefined,
		});
		return Response.json(data, { headers: { "Cache-Control": "private, max-age=30" } });
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const body = await ctx.request.json();
		const data = await client.automations.create(body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
