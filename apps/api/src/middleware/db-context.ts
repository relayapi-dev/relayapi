import { createDb } from "@relayapi/db";
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

/**
 * Creates a single Drizzle instance per request and exposes it via `c.get("db")`.
 * Downstream middleware and route handlers should read the shared instance instead
 * of calling `createDb()` themselves, avoiding repeated postgres client allocations.
 *
 * Hyperdrive pools the underlying TCP, so instantiation is cheap — this refactor
 * is about allocation hygiene and giving a single place to add request-scoped
 * instrumentation later.
 */
export const dbContextMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	c.set("db", createDb(c.env.HYPERDRIVE.connectionString));
	await next();
});
