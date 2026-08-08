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

	const url = new URL(context.request.url);
	const limit = Math.min(
		Math.max(Number(url.searchParams.get("limit")) || 50, 1),
		100,
	);
	const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
	const search = url.searchParams.get("search")?.trim() || undefined;
	try {
		return Response.json(
			await client.admin.listOrganizations({ limit, offset, search }),
		);
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
		organizationId?: string;
		name?: string;
		slug?: string;
		plan?: "free" | "pro";
		aiEnabled?: boolean;
		dailyToolLimitOverride?: number | null;
	};
	if (!body.organizationId) {
		return Response.json({ error: "organizationId required" }, { status: 400 });
	}
	try {
		const result = await client.admin.updateOrganization(body.organizationId, {
			...(body.name !== undefined ? { name: body.name } : {}),
			...(body.slug !== undefined ? { slug: body.slug } : {}),
			...(body.plan !== undefined ? { plan: body.plan } : {}),
			...(body.aiEnabled !== undefined ? { aiEnabled: body.aiEnabled } : {}),
			...(body.dailyToolLimitOverride !== undefined
				? { dailyToolLimitOverride: body.dailyToolLimitOverride }
				: {}),
		});
		return Response.json(result);
	} catch (error) {
		return handleSdkError(error);
	}
};

export const DELETE: APIRoute = async (context) => {
	const denied = adminGuard(context);
	if (denied) return denied;
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	const body = (await context.request.json()) as {
		organizationId?: string;
	};
	const organizationId = body.organizationId;
	if (!organizationId) {
		return Response.json({ error: "organizationId required" }, { status: 400 });
	}
	try {
		return Response.json(await client.organizations.delete(organizationId));
	} catch (error) {
		return handleSdkError(error);
	}
};
