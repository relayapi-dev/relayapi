import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireParam,
	requireSessionBoundClient,
} from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const data = await boundClient.client.autoPostRules.activate(
			id,
			boundClient.requestOptions,
		);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
