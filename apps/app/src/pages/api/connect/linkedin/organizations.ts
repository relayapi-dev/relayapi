import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	try {
		const connectToken = ctx.url.searchParams.get("connect_token");
		if (!connectToken)
			return Response.json(
				{
					error: { code: "BAD_REQUEST", message: "connect_token is required" },
				},
				{ status: 400 },
			);
		const data = await client.connect.linkedin.organizations.list(
			{ connect_token: connectToken },
			requestOptions,
		);
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
		const data = await client.connect.linkedin.organizations.select(
			body,
			requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
