import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.connect.startOAuthFlow(
			ctx.params.platform as Parameters<
				typeof client.connect.startOAuthFlow
			>[0],
			{
				redirect_url: url.searchParams.get("redirect_url") || undefined,
				method: url.searchParams.get("method") || undefined,
				instance_url: url.searchParams.get("instance_url") || undefined,
				headless: url.searchParams.get("headless") || undefined,
				workspace_id: url.searchParams.get("workspace_id") || undefined,
			},
			requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
