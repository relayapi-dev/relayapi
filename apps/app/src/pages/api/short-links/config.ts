import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireSessionBoundClient,
} from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const data = await client.shortLinks.getConfig();
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const PUT: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	try {
		const body = await ctx.request.json();
		const data = await boundClient.client.shortLinks.updateConfig(
			body,
			boundClient.requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
