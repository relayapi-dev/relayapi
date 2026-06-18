import type { APIRoute } from "astro";
import { requireClient, requireParam, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	const channelId = requireParam(ctx.params, "channelId");
	if (channelId instanceof Response) return channelId;
	try {
		await client.contacts.removeChannel(id, channelId);
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
