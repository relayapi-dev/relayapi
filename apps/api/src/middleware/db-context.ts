import { createDb } from "@relayapi/db";
import { createMiddleware } from "hono/factory";
import { getRequestDb } from "../lib/request-db";
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
	const perf = c.get("perf");
	if (perf && !(c.env as { TEST_DB?: unknown }).TEST_DB) {
		// Perf instrumentation enabled — count every query this request issues
		c.set(
			"db",
			createDb(c.env.HYPERDRIVE.connectionString, {
				onQuery: (sql) => perf.recordQuery(sql),
			}),
		);
	} else {
		c.set("db", getRequestDb(c.env));
	}
	await next();
});
