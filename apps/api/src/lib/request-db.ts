import { createDb } from "@relayapi/db";
import type { Env } from "../types";

type RequestDb = ReturnType<typeof createDb>;
type EnvWithDbOverride = Env & { TEST_DB?: RequestDb };

/**
 * Bun app tests can inject a lightweight DB double onto the env to keep
 * request-level test coverage off a real Postgres connection.
 */
export function getRequestDb(env: Env): RequestDb {
	const override = (env as EnvWithDbOverride).TEST_DB;
	return override ?? createDb(env.HYPERDRIVE.connectionString);
}
