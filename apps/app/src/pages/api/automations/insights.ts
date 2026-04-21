import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

// Org-wide automation insights rollup. Optionally filter by
// `created_from_template` (for template performance comparisons) or
// `workspace_id`.
export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.automations.insights(null, {
			period: (url.searchParams.get("period") as never) || undefined,
			from: url.searchParams.get("from") || undefined,
			to: url.searchParams.get("to") || undefined,
			created_from_template:
				url.searchParams.get("created_from_template") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
