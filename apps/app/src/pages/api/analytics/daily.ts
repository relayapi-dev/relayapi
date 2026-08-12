import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		type Platform = NonNullable<
			Parameters<typeof client.analytics.listDailyMetrics>[0]
		>["platform"];
		const query = {
			account_id: url.searchParams.get("account_id") || undefined,
			from_date: url.searchParams.get("from_date") || undefined,
			to_date: url.searchParams.get("to_date") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
			platform: (url.searchParams.get("platform") || undefined) as Platform,
		};
		const data = await client.analytics.listDailyMetrics(query);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
