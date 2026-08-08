import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.connect.fetchPendingData(
			{ token: url.searchParams.get("token") || "" },
			requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
