import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

// The `schema` endpoint was renamed to `catalog` in the v2 automation rebuild.
// Keep the path alive by proxying to the new surface so existing dashboard
// callers keep working during the Plan 2 migration window.
export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const data = await client.automations.catalog();
		return Response.json(data, {
			headers: { "Cache-Control": "private, max-age=300" },
		});
	} catch (e) {
		return handleSdkError(e);
	}
};
