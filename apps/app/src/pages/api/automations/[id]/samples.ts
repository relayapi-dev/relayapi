import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const url = new URL(ctx.request.url);
		const data = await (
			client.automations as unknown as {
				listSamples: (
					automationId: string,
					query: { limit?: number },
				) => Promise<unknown>;
			}
		).listSamples(id, {
			limit: Number(url.searchParams.get("limit")) || 10,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
