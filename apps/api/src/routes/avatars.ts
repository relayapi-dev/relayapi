import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

// Avatars are stored in the Workers edge cache (max-age alone never populates
// Cloudflare's cache on Workers — it must be written explicitly). The key
// `avatars/{id}` is stable but its CONTENT changes when an account re-hosts its
// avatar or is reconnected, and there is no reliable cross-colo cache purge on
// Workers — so bound staleness to 1h rather than a day. The edge-cache hit
// still removes the R2 GET + body stream on the hot path.
const AVATAR_CACHE_CONTROL = "public, max-age=3600";

// Minimal Workers Cache surface. The ambient DOM `CacheStorage` (pulled in by the
// default lib) has no `.default`, so we narrow `caches` to the Workers shape.
interface WorkersCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

// Resolve the Workers edge cache lazily inside the handler — `caches` is a
// runtime global that does not exist outside the Workers runtime (e.g. under
// `bun test`), so touching it at module scope would crash app initialization.
function getEdgeCache(): WorkersCache | null {
	const g = (globalThis as { caches?: { default?: WorkersCache } }).caches;
	return g?.default ?? null;
}

// Public: serve a re-hosted social-account avatar from R2. No auth — <img> tags
// cannot send a Bearer key, and avatars are public profile pictures. The key is
// derived from the account id (avatars/{id}); content-type lives in R2 metadata.
app.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!id) return new Response("Not found", { status: 404 });

	// Edge cache: serve from caches.default when warm so most requests skip both
	// the R2 GET and the Worker body streaming.
	const edgeCache = getEdgeCache();
	const cached = await edgeCache?.match(c.req.raw);
	if (cached) return cached;

	const object = await c.env.MEDIA_BUCKET.get(`avatars/${id}`);
	if (!object) return new Response("Not found", { status: 404 });

	const etag = object.httpEtag;
	const ifNoneMatch = c.req.header("if-none-match");
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, { status: 304 });
	}

	const response = new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType || "image/jpeg",
			"Cache-Control": AVATAR_CACHE_CONTROL,
			ETag: etag,
		},
	});

	// Populate the edge cache without blocking the response.
	if (edgeCache) {
		c.executionCtx.waitUntil(edgeCache.put(c.req.raw, response.clone()));
	}
	return response;
});

export default app;
