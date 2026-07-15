import type { APIRoute } from "astro";
import { handleSdkError, requireClient, requireParam } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const body = await ctx.request.json();
		const data = await client.workspaces.update(id, body);
		return Response.json(data);
	} catch (e) {
		return handleSdkError(e);
	}
};

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	const id = requireParam(ctx.params, "id");
	if (id instanceof Response) return id;
	try {
		const body = (await ctx.request.json()) as {
			action?: "archive" | "restore";
			expected_revision?: number;
		};
		if (typeof body.expected_revision !== "number") {
			return Response.json(
				{ error: { code: "BAD_REQUEST", message: "expected_revision is required" } },
				{ status: 400 },
			);
		}
		const params = { expected_revision: body.expected_revision };
		const data =
			body.action === "restore"
				? await client.workspaces.restore(id, params)
				: body.action === "archive"
					? await client.workspaces.archive(id, params)
					: null;
		if (!data) {
			return Response.json(
				{ error: { code: "BAD_REQUEST", message: "Unknown workspace action" } },
				{ status: 400 },
			);
		}
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
		const body = await ctx.request.json();
		const data = await client.workspaces.delete(id, body);
		return Response.json(data, { status: 202 });
	} catch (e) {
		return handleSdkError(e);
	}
};
