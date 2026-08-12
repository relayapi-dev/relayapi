import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const adAccountId = url.searchParams.get("ad_account_id")?.trim();
		if (!adAccountId) {
			return Response.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: "ad_account_id is required",
					},
				},
				{ status: 400 },
			);
		}
		const data = await client.ads.listAudiences({
			ad_account_id: adAccountId,
			cursor: url.searchParams.get("cursor") || undefined,
			limit: Number(url.searchParams.get("limit")) || 20,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const body = await ctx.request.json();
		const data = await client.ads.createAudience(body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
