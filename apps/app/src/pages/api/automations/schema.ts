import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const data = await client.automations.schema();
		return Response.json(data, {
			headers: { "Cache-Control": "private, max-age=300" },
		});
	} catch (e) {
		return handleSdkError(e);
	}
};
