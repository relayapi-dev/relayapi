import type Relay from "@relayapi/sdk";
import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireSessionBoundClient,
} from "@/lib/api-utils";

type CreateWebhookInput = Parameters<Relay["webhooks"]["create"]>[0];

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.webhooks.list({
			limit: Number(url.searchParams.get("limit")) || 20,
			cursor: url.searchParams.get("cursor") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	let body: CreateWebhookInput;
	try {
		body = (await ctx.request.json()) as CreateWebhookInput;
	} catch {
		return Response.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: "Expected a JSON request body.",
				},
			},
			{ status: 400 },
		);
	}
	try {
		const data = await boundClient.client.webhooks.create(
			body,
			boundClient.requestOptions,
		);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
