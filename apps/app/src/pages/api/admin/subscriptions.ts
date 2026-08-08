import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

function adminGuard(context: { locals: App.Locals }): Response | null {
	if (context.locals.user?.role === "admin") return null;
	return Response.json({ error: "Forbidden" }, { status: 403 });
}

export const GET: APIRoute = async (context) => {
	const denied = adminGuard(context);
	if (denied) return denied;
	const client = await requireClient(context);
	if (client instanceof Response) return client;
	try {
		return Response.json(await client.admin.listSubscriptions());
	} catch (error) {
		return handleSdkError(error);
	}
};

export const PATCH: APIRoute = async (context) => {
	const denied = adminGuard(context);
	if (denied) return denied;
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	const body = (await context.request.json()) as {
		id?: string;
		status?: "active" | "cancelled";
	};
	if (!body.id) {
		return Response.json(
			{ error: "Subscription ID required" },
			{ status: 400 },
		);
	}
	try {
		const result = await client.admin.updateSubscription(body.id, {
			...(body.status !== undefined ? { status: body.status } : {}),
		});
		return Response.json(result);
	} catch (error) {
		return handleSdkError(error);
	}
};
