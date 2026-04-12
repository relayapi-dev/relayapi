import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		await client.contacts.removeChannel(ctx.params.id!, ctx.params.channelId!);
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
