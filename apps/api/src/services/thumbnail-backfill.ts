import { createDb, media } from "@relayapi/db";
import { and, desc, isNull, like, or } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { generateAndStoreThumbnail } from "../lib/thumbnails";
import type { Env } from "../types";

/**
 * One-time, self-terminating backfill: generate durable preview thumbnails for
 * existing image/video media uploaded before the thumbnail pipeline existed,
 * whose full-res original is still present in R2 (i.e. not yet lifecycle-deleted).
 * This pre-populates thumbnails so previews survive the upcoming expiry.
 *
 * Runs a small batch per cron tick and becomes a cheap no-op once every row has
 * been handled. To avoid reprocessing rows whose original is already gone (or
 * that genuinely fail to transform), we mark them with an empty-string
 * thumbnailUrl — distinct from NULL ("not yet attempted") — which the read path
 * treats as "no thumbnail".
 *
 * Note: media rows whose original was already lifecycle-deleted under the OLD
 * behavior (row hard-deleted) are gone and unrecoverable here. Converting
 * already-expired platform CDN thumbnails for synced external posts into durable
 * R2 copies is a separate follow-up requiring per-platform token handling.
 */
const BACKFILL_BATCH = 25;

export async function backfillMissingThumbnails(
	env: Env,
	limit: number = BACKFILL_BATCH,
): Promise<void> {
	// Without the Images binding every generation would fail; bail rather than
	// poisoning rows with the "attempted, unavailable" sentinel.
	if (!env.IMAGES) return;

	const db = createDb(env.HYPERDRIVE.connectionString);

	const rows = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
			mimeType: media.mimeType,
		})
		.from(media)
		.where(
			and(
				isNull(media.thumbnailUrl),
				or(like(media.mimeType, "image/%"), like(media.mimeType, "video/%")),
			),
		)
		// Newest first: most likely to still have a live R2 original.
		.orderBy(desc(media.createdAt))
		.limit(limit);

	for (const row of rows) {
		const result = await generateAndStoreThumbnail(
			env,
			row.storageKey,
			row.mimeType,
		);
		// Persist either the generated thumbnail or the "" sentinel so the row is
		// not retried indefinitely when the original is gone / unsupported.
		await db
			.update(media)
			.set({
				thumbnailKey: result?.thumbnailKey ?? null,
				thumbnailUrl: result?.thumbnailUrl ?? "",
			})
			.where(eq(media.id, row.id));
	}
}
