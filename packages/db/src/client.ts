import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Creates a new Drizzle DB client. Must be called per-request.
 *
 * Cloudflare Workers do not allow I/O (sockets) to be reused across
 * request boundaries. Hyperdrive manages the real connection pool on
 * the server side, so creating a new postgres() client per request
 * is cheap — it connects to Hyperdrive's local proxy, not the origin DB.
 *
 * Options per Cloudflare Hyperdrive docs:
 * - prepare: true  — lets Hyperdrive cache prepared statements (fewer round-trips)
 * - max: 5         — Workers limit on concurrent outbound connections per request
 * - fetch_types: false — skip extra round-trip for type metadata
 */
export function createDb(connectionString: string) {
	const client = postgres(connectionString, {
		prepare: true,
		max: 5,
		fetch_types: false,
	});
	return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
