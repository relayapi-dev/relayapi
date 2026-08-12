import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireIdempotencyKey,
	requireParam,
} from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const data = await client.ads.retrieveCampaign(id);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const PATCH: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	const idempotencyKey = requireIdempotencyKey(ctx.request);
	if (idempotencyKey instanceof Response) return idempotencyKey;
	try {
		const body = await ctx.request.json();
		const data = await client.ads.updateCampaign(id, body, { idempotencyKey });
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	const idempotencyKey = requireIdempotencyKey(ctx.request);
	if (idempotencyKey instanceof Response) return idempotencyKey;
	try {
		await client.ads.deleteCampaign(id, { idempotencyKey });
		return Response.json({ message: "Campaign cancelled" });
	} catch (e) {
		return handleSdkError(e);
	}
};
