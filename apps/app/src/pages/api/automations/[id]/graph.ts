import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const PUT: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	try {
		const id = ctx.params.id as string;
		const body = await ctx.request.json();
		const data = await boundClient.client.automations.updateGraph(
			id,
			body,
			boundClient.requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
