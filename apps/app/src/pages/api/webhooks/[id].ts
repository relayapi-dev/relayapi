import type Relay from "@relayapi/sdk";
import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireParam,
	requireSessionBoundClient,
} from "@/lib/api-utils";

type UpdateWebhookInput = Parameters<Relay["webhooks"]["update"]>[1];

export const PATCH: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	let body: UpdateWebhookInput;
	try {
		body = (await ctx.request.json()) as UpdateWebhookInput;
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
		const data = await boundClient.client.webhooks.update(
			id,
			body,
			boundClient.requestOptions,
		);
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
	try {
		await client.webhooks.delete(id);
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
