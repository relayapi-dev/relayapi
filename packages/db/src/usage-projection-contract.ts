/**
 * `usage_reservations` is the durable billing ledger. The counters on
 * `usage_buckets` are a hot-path projection used to decide quota without
 * aggregating an unbounded monthly ledger on every request.
 *
 * PostgreSQL owns that projection: statement-level transition-table triggers
 * apply one grouped delta per affected bucket, and a bucket guard rejects
 * direct counter writes.
 */
export const USAGE_BUCKET_PROJECTION_CONTRACT = {
	tableSchema: "public",
	bucketTable: "usage_buckets",
	reservationTable: "usage_reservations",
	projectionFunctionSchema: "public",
	projectionFunctionName: "maintain_usage_bucket_projection",
	guardFunctionSchema: "public",
	guardFunctionName: "enforce_usage_bucket_projection_ownership",
	ownershipMarker: "relay.usage_projection",
	triggers: {
		insert: {
			name: "usage_reservations_project_after_insert",
			operation: "INSERT",
			oldTransitionTable: null,
			newTransitionTable: "new_usage_reservations",
		},
		update: {
			name: "usage_reservations_project_after_update",
			operation: "UPDATE",
			oldTransitionTable: "old_usage_reservations",
			newTransitionTable: "new_usage_reservations",
		},
		delete: {
			name: "usage_reservations_project_after_delete",
			operation: "DELETE",
			oldTransitionTable: "old_usage_reservations",
			newTransitionTable: null,
		},
		bucketGuard: {
			name: "usage_buckets_projection_owned",
		},
	},
} as const;
