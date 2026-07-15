import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import {
	createRelayApiShortLinkStore,
	resolveRelayApiRedirect,
} from "../services/short-link-providers/relayapi";
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

	let resolved: Awaited<ReturnType<typeof resolveRelayApiRedirect>>;
	try {
		const db = createDb(c.env.HYPERDRIVE.connectionString);
		resolved = await resolveRelayApiRedirect({
			store: createRelayApiShortLinkStore(db),
			cache: c.env.KV,
			shortCode: code,
		});
	} catch (error) {
		console.error(`[ShortLinks] Failed to resolve code ${code}:`, error);
		return c.json(
			{
				error: {
					code: "SHORT_LINK_UNAVAILABLE",
					message: "Short link is temporarily unavailable",
				},
			},
			503,
		);
	}

	// A KV-only entry is deliberately ignored: no durable row means no link.
	if (!resolved) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Short link not found" } },
			404,
		);
	}

	if (!isSafePublicRedirectTarget(resolved.originalUrl)) {
		console.error(
			`[ShortLinks] Blocked unsafe redirect target for code ${code}`,
		);
		return c.json(
			{
				error: {
					code: "INVALID_REDIRECT_TARGET",
					message: "Short link target is invalid",
				},
			},
			400,
		);
	}

	return c.redirect(resolved.originalUrl, 302);
});

export default app;
