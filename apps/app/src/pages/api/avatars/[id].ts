import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

// Minimal structural type for the R2 binding operations used here. The full
// `R2Bucket` ambient type from @cloudflare/workers-types isn't loaded in this
// app's tsconfig, so we describe only the surface we touch.
interface MediaBucket {
  list(options: {
    prefix?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }> }>;
  get(key: string): Promise<{
    body: ReadableStream;
    etag: string;
    httpMetadata?: { contentType?: string };
  } | null>;
}

export const GET: APIRoute = async (ctx) => {
  const id = ctx.params.id;
  if (!id) {
    return new Response("Not found", { status: 404 });
  }

  const bucket = env.AVATARS_BUCKET as MediaBucket;
  const listed = await bucket.list({ prefix: `${id}.`, limit: 1 });

  const firstObject = listed.objects[0];
  if (!firstObject) {
    return new Response("Not found", { status: 404 });
  }

  const key = firstObject.key;
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
