import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

// The automation catalog (node kinds, entrypoint kinds, binding types,
// channel capabilities, template kinds). Cached aggressively client-side
// because the contents only change on API deploys.
export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const data = await client.automations.catalog();
		return Response.json(data, {
			headers: { "Cache-Control": "private, max-age=300" },
		});
	} catch (e) {
		return handleSdkError(e);
	}
};
