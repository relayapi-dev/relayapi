import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

// Public: serve a re-hosted social-account avatar from R2. No auth — <img> tags
// cannot send a Bearer key, and avatars are public profile pictures. The key is
// derived from the account id (avatars/{id}); content-type lives in R2 metadata.
app.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!id) return new Response("Not found", { status: 404 });

	const object = await c.env.MEDIA_BUCKET.get(`avatars/${id}`);
	if (!object) return new Response("Not found", { status: 404 });

	const etag = object.httpEtag;
	const ifNoneMatch = c.req.header("if-none-match");
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, { status: 304 });
	}

	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType || "image/jpeg",
			"Cache-Control": "public, max-age=3600",
			ETag: etag,
		},
	});
});

export default app;
