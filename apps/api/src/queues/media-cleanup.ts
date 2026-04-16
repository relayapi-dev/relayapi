import { createDb, media } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Env } from "../types";

interface MediaCleanupMessage {
	account: string;
	bucket: string;
	object: { key: string };
	action: string;
}

export async function consumeMediaCleanupQueue(
	batch: MessageBatch<MediaCleanupMessage>,
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	for (const message of batch.messages) {
		const body = message.body;
		try {
			await db.delete(media).where(eq(media.storageKey, body.object.key));
			console.log(`[Media Cleanup] Deleted DB record for ${body.object.key}`);
			message.ack();
		} catch (err) {
			console.error(`[Media Cleanup] Failed for ${body.object.key}:`, err);
			message.retry({ delaySeconds: 30 });
		}
	}
}
