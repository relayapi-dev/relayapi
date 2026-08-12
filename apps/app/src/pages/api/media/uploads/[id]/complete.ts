import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const body = await ctx.request.json();
		return Response.json(await client.media.completeUploadSession(id, body));
	} catch (error) {
		return handleSdkError(error);
	}
};
