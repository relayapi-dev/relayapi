import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const id = ctx.params.id as string;
		const enrollmentId = ctx.params.enrollmentId as string;
		const data = await client.automations.listRuns(id, enrollmentId);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};
