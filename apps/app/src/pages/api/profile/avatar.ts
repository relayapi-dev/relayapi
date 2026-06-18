import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

// Minimal structural type for the R2 binding operations used here. The full
// `R2Bucket` ambient type from @cloudflare/workers-types isn't loaded in this
// app's tsconfig, so we describe only the surface we touch.
interface MediaObject {
  key: string;
}
interface MediaBucket {
  list(options: { prefix?: string }): Promise<{ objects: MediaObject[] }>;
  delete(keys: string[]): Promise<void>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MAX_SIZE = 2 * 1024 * 1024; // 2MB

export const POST: APIRoute = async (ctx) => {
  const user = ctx.locals.user as { id: string } | null;
  if (!user) {
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

  const bucket = env.AVATARS_BUCKET as MediaBucket;

  // Delete any existing avatar for this user
  const existing = await bucket.list({ prefix: `${user.id}.` });
  if (existing.objects.length > 0) {
    await bucket.delete(existing.objects.map((o: MediaObject) => o.key));
  }

  // Upload new avatar
  const key = `${user.id}.${ext}`;
  await bucket.put(key, body, {
    httpMetadata: { contentType },
  });

  const url = `/api/avatars/${user.id}`;
  return Response.json({ url }, { status: 201 });
};

export const DELETE: APIRoute = async (ctx) => {
  const user = ctx.locals.user as { id: string } | null;
  if (!user) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const bucket = env.AVATARS_BUCKET as MediaBucket;

  const existing = await bucket.list({ prefix: `${user.id}.` });
  if (existing.objects.length > 0) {
    await bucket.delete(existing.objects.map((o: MediaObject) => o.key));
  }

  return new Response(null, { status: 204 });
};
