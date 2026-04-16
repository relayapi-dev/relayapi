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
			const key = `sl:${code}:clicks`;
			const current = await c.env.KV.get(key);
			const count = current ? parseInt(current, 10) : 0;
			await c.env.KV.put(key, String(count + 1));
		})(),
	);

	return c.redirect(originalUrl, 302);
});

export default app;
