import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const url = new URL(ctx.request.url);
		const data = await client.automations.insights(id, {
			period: (url.searchParams.get("period") as never) || undefined,
			from: url.searchParams.get("from") || undefined,
			to: url.searchParams.get("to") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
