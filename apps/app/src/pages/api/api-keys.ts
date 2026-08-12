import type Relay from "@relayapi/sdk";
import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireOrganizationAdmin,
	requireSessionBoundClient,
} from "@/lib/api-utils";

type CreateApiKeyInput = Parameters<Relay["apiKeys"]["create"]>[0];

export const GET: APIRoute = async (ctx) => {
	const denied = await requireOrganizationAdmin(
		ctx,
		"Only organization admins can manage API keys.",
	);
	if (denied) return denied;
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const data = await client.apiKeys.list({
			limit: Number(url.searchParams.get("limit")) || 20,
			cursor: url.searchParams.get("cursor") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const denied = await requireOrganizationAdmin(
		ctx,
		"Only organization admins can manage API keys.",
	);
	if (denied) return denied;
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	let body: CreateApiKeyInput;
	try {
		body = (await ctx.request.json()) as CreateApiKeyInput;
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
		const data = await boundClient.client.apiKeys.create(
			body,
			boundClient.requestOptions,
		);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
