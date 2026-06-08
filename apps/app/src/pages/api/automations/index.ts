import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

// List automations for the authenticated org/workspace. Powers the
// `start_automation` node editor's target picker. Read-only; goes through the
// SDK like every other app → API call.
export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const url = new URL(ctx.request.url);
		const status = url.searchParams.get("status");
		const channel = url.searchParams.get("channel");
		const data = await client.automations.list({
			limit: Number(url.searchParams.get("limit")) || 100,
			cursor: url.searchParams.get("cursor") || undefined,
			workspace_id: url.searchParams.get("workspace_id") || undefined,
			status: (status as "draft" | "active" | "paused" | "archived") || undefined,
			channel:
				(channel as "instagram" | "facebook" | "whatsapp" | "telegram") ||
				undefined,
		});
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
