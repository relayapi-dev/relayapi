import { createDb, type Database, media } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { purgePresignedViewCache } from "../lib/r2-presign";
import {
	generateAndStoreThumbnail,
	isThumbnailable,
	thumbnailKeyFor,
} from "../lib/thumbnails";
import type { Env } from "../types";

interface MediaEventMessage {
	account: string;
	bucket: string;
	object: { key: string };
	action: string;
}

// R2 object-creation actions. Both upload paths in routes/media.ts insert the
// media row before (presigned: pending row at presign time) or immediately after
// (direct: same request) the object lands, so by the time these async events
// arrive the row exists — a missing row means a non-media object (avatar / idea
// media) we should skip rather than retry.
const CREATE_ACTIONS = new Set([
	"PutObject",
	"CopyObject",
	"CompleteMultipartUpload",
]);

/**
 * Consumer for relayapi-media R2 event notifications (queue: relayapi-media-cleanup).
 * Handles three concerns over the media library's R2 objects:
 *  - creation  → generate a durable, hyper-optimized preview thumbnail.
 *  - lifecycle → the original aged out; keep the row + thumbnail (null the dead
 *                original url) so previews survive; preserve storageKey as the
 *                join key from the post _media snapshot.
 *  - delete    → explicit user deletion; remove the row and the thumbnail.
 */
export async function consumeMediaCleanupQueue(
	batch: MessageBatch<MediaEventMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	for (const message of batch.messages) {
		const body = message.body;
		const key = body.object.key;

		try {
			if (CREATE_ACTIONS.has(body.action)) {
				await handleMediaCreated(db, env, key);
			} else if (body.action === "LifecycleDeletion") {
				await handleLifecycleDeletion(db, env, key);
			} else if (body.action === "DeleteObject") {
				await handleExplicitDeletion(db, env, key);
			}
			// Any other action (e.g. unrelated notification) falls through to ack.
			message.ack();
		} catch (err) {
			console.error(`[Media Event] ${body.action} failed for ${key}:`, err);
			message.retry({ delaySeconds: 30 });
		}
	}
}

/** Generate + persist a tiny WebP preview for a newly uploaded image/video. */
async function handleMediaCreated(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	const [row] = await db
		.select({
			id: media.id,
			mimeType: media.mimeType,
			thumbnailUrl: media.thumbnailUrl,
		})
		.from(media)
		.where(eq(media.storageKey, key))
		.limit(1);

	// Non-media object (avatar, idea media) — nothing to do.
	if (!row) return;
	// Idempotent: a retried/duplicate event must not regenerate.
	if (row.thumbnailUrl) return;
	if (!isThumbnailable(row.mimeType)) return;

	const result = await generateAndStoreThumbnail(env, key, row.mimeType);
	if (!result) return;

	await db
		.update(media)
		.set({ thumbnailKey: result.thumbnailKey, thumbnailUrl: result.thumbnailUrl })
		.where(eq(media.id, row.id));
}

/**
 * Lifecycle deletion of the full-res original. Keep the row when it has a durable
 * thumbnail (null only the dead url, preserve storageKey/thumbnail); otherwise
 * there is nothing left to show, so remove the row (prior behavior).
 */
async function handleLifecycleDeletion(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	const [row] = await db
		.select({ thumbnailUrl: media.thumbnailUrl })
		.from(media)
		.where(eq(media.storageKey, key))
		.limit(1);

	if (row?.thumbnailUrl) {
		await db.update(media).set({ url: null }).where(eq(media.storageKey, key));
	} else {
		await db.delete(media).where(eq(media.storageKey, key));
	}
	// Stop serving the now-dead presigned GET URL from KV.
	await purgePresignedViewCache(env, key);
}

/** Explicit user deletion — drop the row and the thumbnail object. */
async function handleExplicitDeletion(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	await db.delete(media).where(eq(media.storageKey, key));
	await env.THUMBNAIL_BUCKET.delete(thumbnailKeyFor(key)).catch(() => {});
	await purgePresignedViewCache(env, key);
}
