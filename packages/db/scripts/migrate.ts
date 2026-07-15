import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
	verifyLiveMigrationHistory,
	verifyTrackedMigrationManifest,
} from "./verify-migration-history";

const connectionString =
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error(
		"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is not set",
	);
}

const parsed = new URL(connectionString);
const runtimeRole = process.env.DATABASE_RUNTIME_ROLE ?? "relayapi_runtime";
if (decodeURIComponent(parsed.username) === runtimeRole) {
	throw new Error(
		`Refusing to run migrations with the no-DDL runtime role ${runtimeRole}`,
	);
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (
	!loopbackHosts.has(parsed.hostname) &&
	parsed.searchParams.get("sslmode") !== "verify-full"
) {
	throw new Error(
		"Non-loopback migration connections must use sslmode=verify-full",
	);
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const expectedHistory = verifyTrackedMigrationManifest();
const sql = postgres(connectionString, {
	max: 1,
	prepare: false,
	connect_timeout: 15,
	idle_timeout: 20,
	max_lifetime: 60 * 15,
});

let locked = false;
try {
	// One global session lock makes concurrent deploy jobs serialize before they
	// inspect or mutate Drizzle's migration ledger. The lock lives on the sole
	// connection in this client until explicitly released below. Bound this
	// blocking statement separately so an abandoned or unexpectedly long deploy
	// cannot consume the entire CI/deploy timeout while waiting for the lock.
	await sql`SET statement_timeout = '60s'`;
	await sql`SELECT pg_advisory_lock(hashtext('relayapi:migrations'))`;
	locked = true;
	await sql`SET lock_timeout = '10s'`;
	await sql`SET statement_timeout = '0'`;
	await sql`SET idle_in_transaction_session_timeout = '60s'`;

	const currentRole = await sql<
		Array<{ current_user: string; session_user: string }>
	>`SELECT current_user, session_user`;
	const identity = currentRole[0];
	if (!identity || identity.current_user !== identity.session_user) {
		throw new Error("Migration connection unexpectedly changed database role");
	}

	// This check must run under the same session advisory lock as the mutation.
	// Drizzle only compares its newest timestamp, so an unlocked preflight cannot
	// protect against an edited older hash or a concurrent deployment race.
	await verifyLiveMigrationHistory(sql, expectedHistory);
	await migrate(drizzle(sql), { migrationsFolder });
	await verifyLiveMigrationHistory(sql, expectedHistory, {
		requireCurrent: true,
	});
	console.log(`Applied reviewed migrations as ${identity.current_user}.`);
} finally {
	if (locked) {
		try {
			await sql`SELECT pg_advisory_unlock(hashtext('relayapi:migrations'))`;
		} catch {
			// Closing the connection releases a session advisory lock even if the
			// explicit unlock cannot be sent after a connection-level failure.
		}
	}
	await sql.end({ timeout: 5 });
}
