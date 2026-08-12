import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const body = await ctx.request.json();
		const data = await client.media.createUploadSession(body);
		return Response.json(data, { status: 201 });
	} catch (error) {
		return handleSdkError(error);
	}
};
