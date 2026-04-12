import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

export const POST: APIRoute = async (ctx) => {
  const user = ctx.locals.user as { id: string } | null;
  const org = ctx.locals.organization as { id: string } | null;
  if (!user || !org) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const contentType = ctx.request.headers.get("content-type") || "";
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Only JPEG, PNG, GIF, or WebP images are allowed" } },
      { status: 400 },
    );
  }

  const body = await ctx.request.arrayBuffer();
  if (body.byteLength > MAX_SIZE) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "File must be under 2MB" } },
      { status: 400 },
    );
  }

  const bucket = (env as any).AVATARS_BUCKET as any;

  // Delete any existing logo for this org
  const existing = await bucket.list({ prefix: `org-${org.id}.` });
  if (existing.objects.length > 0) {
    await bucket.delete(existing.objects.map((o: any) => o.key));
  }

  // Upload new logo
  const key = `org-${org.id}.${ext}`;
  await bucket.put(key, body, {
    httpMetadata: { contentType },
  });

  const url = `/api/org-logo/${org.id}`;
  return Response.json({ url }, { status: 201 });
};

export const DELETE: APIRoute = async (ctx) => {
  const user = ctx.locals.user as { id: string } | null;
  const org = ctx.locals.organization as { id: string } | null;
  if (!user || !org) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const bucket = (env as any).AVATARS_BUCKET as any;

  const existing = await bucket.list({ prefix: `org-${org.id}.` });
  if (existing.objects.length > 0) {
    await bucket.delete(existing.objects.map((o: any) => o.key));
  }

  return new Response(null, { status: 204 });
};
