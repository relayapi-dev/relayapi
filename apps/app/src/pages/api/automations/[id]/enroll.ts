import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireParam,
	requireSessionBoundClient,
} from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	try {
		const id = requireParam(ctx.params, "id");
		if (id instanceof Response) return id;
		const body = await ctx.request.json();
		const data = await boundClient.client.automations.enroll(
			id,
			body,
			boundClient.requestOptions,
		);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
