import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		// GET /v1/analytics defaults to limit=20; the dashboard view requests the
		// schema maximum unless its caller explicitly selects another page size.
		const limitValue = url.searchParams.get("limit");
		const offsetValue = url.searchParams.get("offset");
		type Platform = NonNullable<
			Parameters<typeof client.analytics.retrieve>[0]
		>["platform"];
		const query = {
			account_id: url.searchParams.get("account_id") || undefined,
			from_date: url.searchParams.get("from_date") || undefined,
			to_date: url.searchParams.get("to_date") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
			platform: (url.searchParams.get("platform") || undefined) as Platform,
			post_id: url.searchParams.get("post_id") || undefined,
			limit: limitValue === null ? 100 : Number(limitValue),
			offset: offsetValue === null ? undefined : Number(offsetValue),
		};
		const data = await client.analytics.retrieve(query);
		return Response.json(data, {
			headers: { "Cache-Control": "private, max-age=300" },
		});
	} catch (e) {
		return handleSdkError(e);
	}
};
