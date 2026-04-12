import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const platform = ctx.params.platform;
  if (!platform) {
    return Response.redirect(new URL("/app/connections?tab=connect&error=Missing+platform", ctx.url.origin).toString(), 302);
  }

  const client = await requireClient(ctx);
  if (client instanceof Response) {
    return Response.redirect(new URL("/app/connections?tab=connect&error=Not+authenticated", ctx.url.origin).toString(), 302);
  }

  try {
    const method = ctx.url.searchParams.get("method") || undefined;
    const redirectUrl = `${ctx.url.origin}/app/connect/callback/${platform}`;
    const data = await client.connect.startOAuthFlow(platform as any, { redirect_url: redirectUrl, method });
    return Response.redirect(data.auth_url, 302);
  } catch (e) {
    console.error("OAuth start error:", e);
    const message = e instanceof Error ? e.message : "Failed to start OAuth";
    return Response.redirect(
      new URL(`/app/connections?tab=connect&error=${encodeURIComponent(message)}`, ctx.url.origin).toString(),
      302,
    );
  }
};
