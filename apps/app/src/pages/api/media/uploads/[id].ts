import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		return Response.json(await client.media.retrieveUploadSession(id));
	} catch (error) {
		return handleSdkError(error);
	}
};

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		await client.media.abortUploadSession(id);
		return new Response(null, { status: 204 });
	} catch (error) {
		return handleSdkError(error);
	}
};
