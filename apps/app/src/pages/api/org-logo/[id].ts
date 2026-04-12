import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const GET: APIRoute = async (ctx) => {
  const id = ctx.params.id;
  if (!id) {
    return new Response("Not found", { status: 404 });
  }

  const bucket = (env as any).AVATARS_BUCKET as any;
  const listed = await bucket.list({ prefix: `org-${id}.`, limit: 1 });

  if (listed.objects.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const key = listed.objects[0].key;
  const ifNoneMatch = ctx.request.headers.get("if-none-match");

  const object = await bucket.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  if (ifNoneMatch && ifNoneMatch === object.etag) {
    return new Response(null, { status: 304 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      ETag: object.etag,
    },
  });
};
