import { automationWebhookReceipts, createDb } from "@relayapi/db";
import { inArray, lt } from "drizzle-orm";
import type { Env } from "../types";

const DEFAULT_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 10;

/** Remove expired replay digests in bounded batches outside request paths. */
export async function cleanupAutomationWebhookReceipts(
	env: Env,
	limit = DEFAULT_BATCH_SIZE,
): Promise<number> {
	const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_BATCH_SIZE));
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	let deletedCount = 0;
	for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
		const expired = await db
			.select({ id: automationWebhookReceipts.id })
			.from(automationWebhookReceipts)
			.where(lt(automationWebhookReceipts.expiresAt, now))
			.orderBy(
				automationWebhookReceipts.expiresAt,
				automationWebhookReceipts.id,
			)
			.limit(boundedLimit);
		if (expired.length === 0) break;

		const deleted = await db
			.delete(automationWebhookReceipts)
			.where(
				inArray(
					automationWebhookReceipts.id,
					expired.map((row) => row.id),
				),
			)
			.returning({ id: automationWebhookReceipts.id });
		deletedCount += deleted.length;
		if (expired.length < boundedLimit) break;
	}
	return deletedCount;
}
