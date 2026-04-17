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
			// Enqueue next position with delay
			await env.PUBLISH_QUEUE.send(
				{
					type: "publish_thread_item",
					thread_group_id: threadGroupId,
					org_id: body.org_id,
					position: result.nextPosition,
				},
				{ delaySeconds: Math.ceil(result.nextDelayMs / 1000) },
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
		if (message.attempts >= 5) {
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
		if (message.attempts >= 5) {
			console.error(
				`[Publish] Max retries exceeded for ${body.post_id}, dropping`,
			);
			message.ack();
		} else {
			message.retry({ delaySeconds: 2 ** message.attempts });
		}
	}
}

