import type { APIRoute } from "astro";
import { requireSessionBoundClient } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
	const platform = ctx.params.platform;
	if (!platform) {
		return Response.redirect(
			new URL(
				"/app/connections?tab=connect&error=Missing+platform",
				ctx.url.origin,
			).toString(),
			302,
		);
	}

	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) {
		return Response.redirect(
			new URL(
				"/app/connections?tab=connect&error=Not+authenticated",
				ctx.url.origin,
			).toString(),
			302,
		);
	}
	const { client, requestOptions } = boundClient;

	try {
		const method = ctx.url.searchParams.get("method") || undefined;
		const workspaceId = ctx.url.searchParams.get("workspace_id") || undefined;
		const redirectUrl = `${ctx.url.origin}/app/connect/callback/${platform}`;
		const data = await client.connect.startOAuthFlow(
			platform as Parameters<typeof client.connect.startOAuthFlow>[0],
			{ redirect_url: redirectUrl, method, workspace_id: workspaceId },
			requestOptions,
		);
		return Response.redirect(data.auth_url, 302);
	} catch (e) {
		console.error("OAuth start error:", e);
		const message = e instanceof Error ? e.message : "Failed to start OAuth";
		return Response.redirect(
			new URL(
				`/app/connections?tab=connect&error=${encodeURIComponent(message)}`,
				ctx.url.origin,
			).toString(),
			302,
		);
	}
};
