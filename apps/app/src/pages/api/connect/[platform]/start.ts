import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.connect.startOAuthFlow(
			ctx.params.platform as Parameters<
				typeof client.connect.startOAuthFlow
			>[0],
			{
				redirect_url: url.searchParams.get("redirect_url") || undefined,
				method: url.searchParams.get("method") || undefined,
				headless: url.searchParams.get("headless") || undefined,
				workspace_id: url.searchParams.get("workspace_id") || undefined,
			},
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
