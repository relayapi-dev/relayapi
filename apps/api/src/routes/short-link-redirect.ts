import { createDb, shortLinks } from "@relayapi/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

function isSafePublicRedirectTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

app.get("/:code", async (c) => {
	const code = c.req.param("code");
	const originalUrl = await c.env.KV.get(`sl:${code}`);
	if (!originalUrl) {
		return c.json({ error: { code: "NOT_FOUND", message: "Short link not found" } }, 404);
	}

	if (!isSafePublicRedirectTarget(originalUrl)) {
		console.error(`[ShortLinks] Blocked unsafe redirect target for code ${code}`);
		return c.json(
			{ error: { code: "INVALID_REDIRECT_TARGET", message: "Short link target is invalid" } },
			400,
		);
	}

	c.executionCtx.waitUntil(
		(async () => {
			// Atomic SQL increment is the durable source of truth: KV get-then-put on
			// a single key is eventually consistent (60s colo read cache) and capped at
			// ~1 write/sec, so concurrent clicks silently lose increments. The DB round
			// trip is hidden by waitUntil (post-response). short_url is built as
			// `{domain}/r/{code}` (see short-link-providers/relayapi.ts), so match on the
			// `/r/{code}` suffix.
			try {
				const db = createDb(c.env.HYPERDRIVE.connectionString);
				await db
					.update(shortLinks)
					.set({ clickCount: sql`${shortLinks.clickCount} + 1` })
					.where(sql`${shortLinks.shortUrl} LIKE ${`%/r/${code}`}`);
			} catch (err) {
				console.error(
					`[ShortLinks] Failed to increment click count for code ${code}:`,
					err,
				);
			}
		})(),
	);

	return c.redirect(originalUrl, 302);
});

export default app;
