import { mapConcurrently } from "../lib/concurrency";
import { incrementUsage } from "../middleware/usage-tracking";
import { scheduleFirstMetricsRefresh } from "../services/analytics-refresh";
import { publishPostById } from "../services/publisher-runner";
import type { Env } from "../types";

// Each publish message fans out to multiple platform APIs; cap concurrency
// to keep Hyperdrive happy (Workers allow ~5-6 simultaneous outbound sockets)
// and to avoid spiking external platforms.
const PUBLISH_CONCURRENCY = 5;

interface PublishMessage {
	type: string;
	post_id?: string;
	org_id?: string;
	usage_tracked?: boolean;
	thread_group_id?: string;
	position?: number;
}

export async function consumePublishQueue(
	batch: MessageBatch<PublishMessage>,
	env: Env,
): Promise<void> {
	await mapConcurrently(batch.messages, PUBLISH_CONCURRENCY, async (message) => {
		const body = message.body;

		if (
			(body.type === "publish_thread" || body.type === "publish_thread_item") &&
			body.org_id &&
			body.thread_group_id
		) {
			await handleThreadPublish(
				message,
				body as PublishMessage & { org_id: string; thread_group_id: string },
				env,
			);
		} else if (body.type === "publish" && body.post_id && body.org_id) {
			await handlePostPublish(
				message,
				body as PublishMessage & { post_id: string; org_id: string },
				env,
			);
		} else {
			message.ack();
		}
	});
}

async function handleThreadPublish(
	message: Message<PublishMessage>,
	body: PublishMessage & { org_id: string; thread_group_id: string },
	env: Env,
): Promise<void> {
	try {
		const { publishThreadPosition } = await import(
			"../services/thread-publisher"
		);
		const threadGroupId = body.thread_group_id;
		const position = body.position ?? 0;

		const result = await publishThreadPosition(
			env,
			threadGroupId,
			body.org_id,
			position,
		);

		// Stop chain if current position fully failed
		if (result.positionFailed) {
			console.error(
				`[Thread] Position ${position} fully failed for ${threadGroupId}, stopping chain`,
			);
			message.ack();
			return;
		}

		if (result.nextPosition !== null && result.nextDelayMs > 0) {
			// Enqueue next position with delay. Cloudflare Queues rejects delaySeconds
			// greater than 43200 (12h); the thread schema allows delay_minutes up to 1440
			// (24h), so cap here. Without the cap the send() throws AFTER this position was
			// already published, the catch retries the whole (already-live) position, and
			// the remaining thread items are eventually dropped — breaking the chain.
			const QUEUE_MAX_DELAY_SECONDS = 43200;
			await env.PUBLISH_QUEUE.send(
				{
					type: "publish_thread_item",
					thread_group_id: threadGroupId,
					org_id: body.org_id,
					position: result.nextPosition,
				},
				{
					delaySeconds: Math.min(
						Math.ceil(result.nextDelayMs / 1000),
						QUEUE_MAX_DELAY_SECONDS,
					),
				},
			);
		} else if (result.nextPosition !== null) {
			// Next position has no delay, but was not published (shouldn't happen)
			await env.PUBLISH_QUEUE.send({
				type: "publish_thread_item",
				thread_group_id: threadGroupId,
				org_id: body.org_id,
				position: result.nextPosition,
			});
		}

		message.ack();
	} catch (err) {
		console.error(
			`Thread publish failed for ${body.thread_group_id}:`,
			err,
		);
		// max_retries: 3 → attempts maxes at 4. Use >= 4 so the terminal branch fires on
		// the final attempt rather than being unreachable dead code.
		if (message.attempts >= 4) {
			console.error(
				`[Thread] Max retries exceeded for ${body.thread_group_id}, dropping`,
			);
			message.ack();
		} else {
			message.retry({ delaySeconds: 2 ** message.attempts });
		}
	}
}

async function handlePostPublish(
	message: Message<PublishMessage>,
	body: PublishMessage & { post_id: string; org_id: string },
	env: Env,
): Promise<void> {
	try {
		if (!body.usage_tracked) {
			await incrementUsage(env.KV, body.org_id, 1);
		}
		await publishPostById(env, body.post_id, body.org_id);

		// Schedule first metrics collection 15 minutes after publish
		scheduleFirstMetricsRefresh(env, body.post_id, body.org_id).catch((err) =>
			console.error("[Analytics] Failed to schedule first refresh:", err),
		);

		message.ack();
	} catch (err) {
		console.error(`Queue publish failed for ${body.post_id}:`, err);
		// The relayapi-publish consumer is configured with max_retries: 3, so attempts
		// maxes out at 4 (initial + 3 retries). Use >= 4 so this terminal branch actually
		// runs on the final attempt instead of being dead code (the old >= 5 never fired,
		// and Cloudflare silently dropped the message leaving the post stuck "publishing").
		if (message.attempts >= 4) {
			console.error(
				`[Publish] Max retries exceeded for ${body.post_id}, marking failed`,
			);
			// Move the post out of "publishing" so it is not stuck forever. Only flip a
			// post that is still "publishing" (don't clobber a post another path finalized).
			try {
				await markPostFailedOnDrop(env, body.post_id, body.org_id);
			} catch (markErr) {
				console.error(
					`[Publish] Failed to mark ${body.post_id} failed on drop:`,
					markErr,
				);
			}
			message.ack();
		} else {
			message.retry({ delaySeconds: 2 ** message.attempts });
		}
	}
}

/**
 * On terminal publish failure (retries exhausted, no dead-letter queue configured for
 * relayapi-publish), move the post out of "publishing" to "failed" so the dashboard
 * does not show it publishing forever and the failure is recorded.
 */
async function markPostFailedOnDrop(
	env: Env,
	postId: string,
	orgId: string,
): Promise<void> {
	const { createDb, posts } = await import("@relayapi/db");
	const { and, eq } = await import("drizzle-orm");
	const db = createDb(env.HYPERDRIVE.connectionString);
	await db
		.update(posts)
		.set({ status: "failed", updatedAt: new Date() })
		.where(
			and(
				eq(posts.id, postId),
				eq(posts.organizationId, orgId),
				eq(posts.status, "publishing"),
			),
		);
}

