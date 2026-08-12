import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		type MediaListParams = NonNullable<Parameters<typeof client.media.list>[0]>;
		const params: MediaListParams = {
			limit: Number(url.searchParams.get("limit")) || 20,
			cursor: url.searchParams.get("cursor") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
		};
		const data = await client.media.list(params);
		return Response.json(data);
	} catch (error) {
		return handleSdkError(error);
	}
};
