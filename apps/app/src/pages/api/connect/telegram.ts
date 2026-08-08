import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const url = new URL(ctx.request.url);
		const code = url.searchParams.get("code");
		if (code) {
			const data = await client.connect.telegram.pollConnectionStatus(
				{ code },
				requestOptions,
			);
			return Response.json(data);
		}
		const data = await client.connect.telegram.initiateConnection(
			{
				workspace_id: url.searchParams.get("workspace_id") || undefined,
			},
			requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
