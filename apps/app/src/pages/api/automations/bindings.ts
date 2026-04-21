import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

function parseQuery(url: URL) {
	const bindingType = url.searchParams.get("binding_type");
	return {
		workspace_id: url.searchParams.get("workspace_id") ?? undefined,
		social_account_id: url.searchParams.get("social_account_id") ?? undefined,
		automation_id: url.searchParams.get("automation_id") ?? undefined,
		binding_type: (bindingType ?? undefined) as any,
	};
}

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.automationBindings.list(parseQuery(url));
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
		const data = await client.automationBindings.create(body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
