import { createDb, oneTimeCapabilities } from "@relayapi/db";
import { inArray, lt } from "drizzle-orm";
import type { Env } from "../types";

const MAX_BATCH = 2_000;
const MAX_BATCHES_PER_RUN = 10;

export async function cleanupOneTimeCapabilities(
	env: Env,
	limit = MAX_BATCH,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const boundedLimit = Math.max(1, Math.min(limit, MAX_BATCH));
	const now = new Date();
	let deletedCount = 0;
	for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
		const rows = await db
			.select({ id: oneTimeCapabilities.id })
			.from(oneTimeCapabilities)
			.where(lt(oneTimeCapabilities.expiresAt, now))
			.orderBy(oneTimeCapabilities.expiresAt, oneTimeCapabilities.id)
			.limit(boundedLimit);
		if (rows.length === 0) break;

		const deleted = await db
			.delete(oneTimeCapabilities)
			.where(
				inArray(
					oneTimeCapabilities.id,
					rows.map((row) => row.id),
				),
			)
			.returning({ id: oneTimeCapabilities.id });
		deletedCount += deleted.length;
		if (rows.length < boundedLimit) break;
	}
	return deletedCount;
}
