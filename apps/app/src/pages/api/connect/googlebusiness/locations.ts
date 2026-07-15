import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const connectToken = ctx.url.searchParams.get("connect_token");
		if (!connectToken)
			return Response.json(
				{
					error: { code: "BAD_REQUEST", message: "connect_token is required" },
				},
				{ status: 400 },
			);
		const data = await client.connect.googlebusiness.locations.list({
			connect_token: connectToken,
		});
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
		const data = await client.connect.googlebusiness.locations.select(body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
