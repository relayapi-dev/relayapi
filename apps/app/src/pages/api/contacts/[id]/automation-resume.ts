import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const body = await ctx.request.json().catch(() => ({}));
		await client.contacts.automationControls.resume(ctx.params.id!, body);
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
