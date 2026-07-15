import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireClient,
	requireOrganizationAdmin,
	requireParam,
} from "@/lib/api-utils";

export const DELETE: APIRoute = async (ctx) => {
	const denied = await requireOrganizationAdmin(
		ctx,
		"Only organization admins can manage API keys.",
	);
	if (denied) return denied;
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
  if (id instanceof Response) return id;
  try {
    await client.apiKeys.delete(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleSdkError(e);
  }
};
