import { POSTGRES_PRIVACY_RETENTION_STORES } from "./privacy-retention-registry";

export type PostgresTimedRetentionStoreId = `postgres:${string}`;

/**
 * The privacy policy must explicitly name who executes each retention promise.
 * Deriving this set from every PostgreSQL store marked `scheduled` makes a new
 * time-bound policy fail exact contract comparison until it has a handler,
 * cadence, physical bound, index, and executable test.
 */
export const POSTGRES_TIMED_RETENTION_STORE_IDS: readonly PostgresTimedRetentionStoreId[] =
	POSTGRES_PRIVACY_RETENTION_STORES.filter(
		(store) => store.retentionExecution === "scheduled",
	).map(({ id }) => id as PostgresTimedRetentionStoreId);
