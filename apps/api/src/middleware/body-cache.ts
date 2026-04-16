import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

function isJsonContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;
	const mimeType = contentType.split(";")[0]!.trim().toLowerCase();
	return mimeType === "application/json" || mimeType.endsWith("+json");
}

/**
 * Parses the JSON request body once and stores it on the context so downstream
 * middleware (workspace validation, scope enforcement, usage tracking) can read
 * it without re-parsing. MUST run before any middleware that reads parsedBody.
 */
export const bodyCacheMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (
		(c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH")
		&& isJsonContentType(c.req.header("content-type"))
	) {
		try {
			const body = await c.req.json();
			c.set("parsedBody", body as Record<string, unknown>);
		} catch {
			c.set("parsedBody", null);
		}
	} else {
		c.set("parsedBody", null);
	}
	await next();
});
