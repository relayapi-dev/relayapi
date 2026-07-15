import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const code = url.searchParams.get("code");
		if (code) {
			const data = await client.connect.telegram.pollConnectionStatus({ code });
			return Response.json(data);
		}
		const data = await client.connect.telegram.initiateConnection({
			workspace_id: url.searchParams.get("workspace_id") || undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
