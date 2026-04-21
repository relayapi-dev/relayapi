import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const data = await client.automations.unarchive(id);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
