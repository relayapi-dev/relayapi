import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const q = url.searchParams.get("q")?.trim();
		if (!q) {
			return Response.json(
				{ error: { code: "INVALID_REQUEST", message: "q is required" } },
				{ status: 400 },
			);
		}
		const data = await client.ads.searchInterests({
			q,
			ad_account_id: url.searchParams.get("ad_account_id") || undefined,
			social_account_id: url.searchParams.get("social_account_id") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
