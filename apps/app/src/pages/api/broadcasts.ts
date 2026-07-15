import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

function parseBroadcastStatus(value: string | null) {
	switch (value) {
		case "draft":
		case "scheduled":
		case "sending":
		case "sent":
		case "partially_failed":
		case "requires_attention":
		case "failed":
		case "cancelled":
			return value;
		default:
			return undefined;
	}
}

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.broadcasts.list({
			account_id: url.searchParams.get("account_id") || undefined,
			status: parseBroadcastStatus(url.searchParams.get("status")),
			cursor: url.searchParams.get("cursor") || undefined,
			limit: Number(url.searchParams.get("limit")) || undefined,
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
		const data = await client.broadcasts.create(body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
