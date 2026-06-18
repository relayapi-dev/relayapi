import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.automationEntrypoints.insights(id, {
			period: (url.searchParams.get("period") as never) || undefined,
			from: url.searchParams.get("from") || undefined,
			to: url.searchParams.get("to") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
