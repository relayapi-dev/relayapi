import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const data = await client.connect.whatsapp.getSDKConfig(requestOptions);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const body = await ctx.request.json();
		if (body.embedded_signup) {
			const data = await client.connect.whatsapp.completeEmbeddedSignup(
				body,
				requestOptions,
			);
			return Response.json(data);
		}
		const data = await client.connect.whatsapp.connectViaCredentials(
			body,
			requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
