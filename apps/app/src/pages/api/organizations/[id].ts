import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireOrganizationOwner,
	requireParam,
} from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
	const denied = requireOrganizationOwner(ctx);
	if (denied) return denied;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	if (ctx.locals.organization?.id !== id) {
		return Response.json(
			{ error: { code: "FORBIDDEN", message: "Organization mismatch" } },
			{ status: 403 },
		);
	}
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const result = await client.organizations.delete(id);
		return Response.json(result, { status: 202 });
	} catch (error) {
		return handleSdkError(error);
	}
};
