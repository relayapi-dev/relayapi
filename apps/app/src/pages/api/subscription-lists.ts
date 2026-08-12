import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;

	try {
		const url = new URL(ctx.request.url);
		const channel = url.searchParams.get("channel");
		type ListParams = NonNullable<
			Parameters<typeof client.subscriptionLists.list>[0]
		>;
		const data = await client.subscriptionLists.list({
			limit: Number(url.searchParams.get("limit")) || 100,
			cursor: url.searchParams.get("cursor") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
			channel: (channel || undefined) as ListParams["channel"],
		});
		return Response.json(data);
	} catch (error) {
		return handleSdkError(error);
	}
};
