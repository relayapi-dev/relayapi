import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		return Response.json(await client.ads.listPlatforms());
	} catch (error) {
		return handleSdkError(error);
	}
};
