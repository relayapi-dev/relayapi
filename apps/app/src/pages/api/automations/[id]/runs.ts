import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const url = new URL(ctx.request.url);
		const data = await client.automationRuns.list(id, {
			cursor: url.searchParams.get("cursor") || undefined,
			limit: Number(url.searchParams.get("limit")) || undefined,
			status: (url.searchParams.get("status") as never) || undefined,
			contact_id: url.searchParams.get("contact_id") || undefined,
			started_after: url.searchParams.get("started_after") || undefined,
			started_before: url.searchParams.get("started_before") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
