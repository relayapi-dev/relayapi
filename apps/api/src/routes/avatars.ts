import { Hono } from "hono";
import {
	accountAvatarKey,
	conversationAvatarKey,
} from "../services/avatar-store";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

// Avatar URLs are stable while their contents may change or be erased. Keep the
// browser's private copy revalidatable with ETag, but never create a shared
// Workers Cache entry that cannot be enumerated or erased across colos.
const AVATAR_CACHE_CONTROL = "private, no-cache";

// Public: serve a re-hosted avatar from R2. No auth — <img> tags cannot send a
// Bearer key, and avatars are public profile pictures. Account objects use the
// durable bucket; inbox conversation avatars retain MEDIA_BUCKET's lifecycle.
app.get("/conversations/:organizationId/:scope/:id", async (c) => {
	const organizationId = c.req.param("organizationId");
	const scope = c.req.param("scope");
	const id = c.req.param("id");
	const workspaceId =
		scope === "organization"
			? null
			: scope.startsWith("workspace-")
				? scope.slice("workspace-".length)
				: undefined;
	if (!organizationId || !id || workspaceId === undefined) {
		return new Response("Not found", { status: 404 });
	}
	const object = await c.env.MEDIA_BUCKET.get(
		conversationAvatarKey(organizationId, workspaceId, id),
	);
	if (!object) return new Response("Not found", { status: 404 });
	const etag = object.httpEtag;
	if (c.req.header("if-none-match") === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				"Cache-Control": AVATAR_CACHE_CONTROL,
				ETag: etag,
			},
		});
	}
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType || "image/jpeg",
			"Cache-Control": AVATAR_CACHE_CONTROL,
			ETag: etag,
		},
	});
});

app.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!id) return new Response("Not found", { status: 404 });

	const object = await c.env.AVATAR_BUCKET.get(accountAvatarKey(id));
	if (!object) return new Response("Not found", { status: 404 });

	const etag = object.httpEtag;
	const ifNoneMatch = c.req.header("if-none-match");
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, {
			status: 304,
			headers: {
				"Cache-Control": AVATAR_CACHE_CONTROL,
				ETag: etag,
			},
		});
	}

	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType || "image/jpeg",
			"Cache-Control": AVATAR_CACHE_CONTROL,
			ETag: etag,
		},
	});
});

export default app;
