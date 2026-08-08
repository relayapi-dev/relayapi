import { createDb, idempotencyReceipts } from "@relayapi/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Env } from "../types";

const STUCK_AFTER_MS = 10 * 60 * 1_000;
const MAX_BATCH = 2_000;

/**
 * Bound receipt retention and park Worker-crash windows as unknown instead of
 * leaving keys permanently in progress. Runs outside request hot paths.
 */
export async function reconcileIdempotencyReceipts(
	env: Env,
	limit = MAX_BATCH,
): Promise<{ reconciled: number; deleted: number }> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const boundedLimit = Math.max(1, Math.min(limit, MAX_BATCH));
	const now = new Date();
	const stale = await db
		.select({ id: idempotencyReceipts.id })
		.from(idempotencyReceipts)
		.where(
			and(
				eq(idempotencyReceipts.state, "in_progress"),
				lt(
					idempotencyReceipts.createdAt,
					new Date(now.getTime() - STUCK_AFTER_MS),
				),
			),
		)
		.orderBy(idempotencyReceipts.createdAt, idempotencyReceipts.id)
		.limit(boundedLimit);
	let reconciled = 0;
	if (stale.length > 0) {
		const rows = await db
			.update(idempotencyReceipts)
			.set({
				state: "unknown",
				lastError:
					"request worker ended before a replayable response was stored",
				updatedAt: now,
			})
			.where(
				and(
					inArray(
						idempotencyReceipts.id,
						stale.map((row) => row.id),
					),
					eq(idempotencyReceipts.state, "in_progress"),
				),
			)
			.returning({ id: idempotencyReceipts.id });
		reconciled = rows.length;
	}

	const expired = await db
		.select({ id: idempotencyReceipts.id })
		.from(idempotencyReceipts)
		.where(lt(idempotencyReceipts.expiresAt, now))
		.orderBy(idempotencyReceipts.expiresAt, idempotencyReceipts.id)
		.limit(boundedLimit);
	let deleted = 0;
	if (expired.length > 0) {
		const rows = await db
			.delete(idempotencyReceipts)
			.where(
				inArray(
					idempotencyReceipts.id,
					expired.map((row) => row.id),
				),
			)
			.returning({ id: idempotencyReceipts.id });
		deleted = rows.length;
	}
	return { reconciled, deleted };
}
