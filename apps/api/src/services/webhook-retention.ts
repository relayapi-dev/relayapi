import { createDb } from "@relayapi/db";
import { sql } from "drizzle-orm";
import type { Env } from "../types";

export const CUSTOMER_WEBHOOK_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_BATCH = 5_000;
const MAX_RETENTION_BATCH = 5_000;

/**
 * Delete bounded terminal customer-webhook history after its public retention
 * window. A nonterminal or future delivery status keeps the entire event, and
 * a recent attempt keeps its parent event even when the occurrence is older.
 */
export async function cleanupCustomerWebhookHistory(
	env: Env,
	limit = DEFAULT_RETENTION_BATCH,
	now = new Date(),
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const boundedLimit = Math.max(1, Math.min(limit, MAX_RETENTION_BATCH));
	const cutoff = new Date(
		now.getTime() - CUSTOMER_WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);

	const deleted = await db.execute<{ id: string }>(sql`
		WITH candidates AS (
			SELECT event.id, event.organization_id
			FROM webhook_events AS event
			WHERE event.created_at < ${cutoff}
			  AND NOT EXISTS (
				SELECT 1
				FROM webhook_deliveries AS delivery
				WHERE delivery.webhook_event_id = event.id
				  AND delivery.organization_id = event.organization_id
				  AND delivery.status NOT IN ('succeeded', 'failed')
			  )
			  AND NOT EXISTS (
				SELECT 1
				FROM webhook_logs AS log
				WHERE log.webhook_event_id = event.id
				  AND log.organization_id = event.organization_id
				  AND log.created_at >= ${cutoff}
			  )
			ORDER BY event.created_at, event.id
			LIMIT ${boundedLimit}
			FOR UPDATE OF event SKIP LOCKED
		)
		DELETE FROM webhook_events AS event
		USING candidates
		WHERE event.id = candidates.id
		  AND event.organization_id = candidates.organization_id
		RETURNING event.id
	`);

	return deleted.length;
}
