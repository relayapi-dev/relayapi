import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const body = await ctx.request.json();
		const data = await client.ideaGroups.update(id, body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const DELETE: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const expectedRevision = Number(
			new URL(ctx.request.url).searchParams.get("expected_revision"),
		);
		if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
			return Response.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: "expected_revision is required",
					},
				},
				{ status: 400 },
			);
		}
		await client.ideaGroups.delete(id, { expected_revision: expectedRevision });
		return new Response(null, { status: 204 });
	} catch (e) {
		return handleSdkError(e);
	}
};
