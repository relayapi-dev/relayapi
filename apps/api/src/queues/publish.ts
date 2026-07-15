import { createDb } from "@relayapi/db";
import { mapConcurrently } from "../lib/concurrency";
import { scheduleFirstMetricsRefresh } from "../services/analytics-refresh";
import { dispatchPublishOutbox } from "../services/publish-outbox";
import {
	type NotificationType,
	sendNotification,
	sendNotificationToOrg,
} from "../services/notification-manager";
import { publishPostById } from "../services/publisher-runner";
import { updateStreak } from "../services/streak";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

// A message already fans out with its own memory-aware target caps. Keep each
// callback batch to one post; Workers may still colocate concurrent callbacks in
// an isolate, so streaming and per-post weighted limits remain the primary
// memory guards. Queue autoscaling retains horizontal throughput.
export const PUBLISH_CONCURRENCY = 1;

const NOTIFICATION_TYPES = new Set<string>([
	"post_failed",
	"post_published",
	"account_disconnected",
	"payment_failed",
	"usage_warning",
	"weekly_digest",
	"marketing",
	"streak_warning",
] satisfies NotificationType[]);

function isNotificationType(value: unknown): value is NotificationType {
	return typeof value === "string" && NOTIFICATION_TYPES.has(value);
}

interface PublishMessage {
	type: string;
	post_id?: string;
	org_id?: string;
	thread_group_id?: string;
	position?: number;
	user_id?: string | null;
	notification_type?: NotificationType;
	title?: string;
	body?: string;
	data?: Record<string, unknown>;
	occurrence_id?: string;
	status?: "published" | "failed" | "partial";
	occurred_at?: string;
	update_streak?: boolean;
	notification?: {
		user_id: string;
		notification_type: NotificationType;
		title: string;
		body: string;
		data?: Record<string, unknown>;
	} | null;
}

function isPostCompletionMessage(
	body: PublishMessage | null,
): body is PublishMessage & {
	post_id: string;
	org_id: string;
	occurrence_id: string;
	occurred_at: string;
	update_streak: boolean;
} {
	if (
		body?.type !== "post_completion_effects" ||
		!body.post_id ||
		!body.org_id ||
		!body.occurrence_id ||
		typeof body.occurred_at !== "string" ||
		!Number.isFinite(Date.parse(body.occurred_at)) ||
		typeof body.update_streak !== "boolean"
	) {
		return false;
	}
	const notification = body.notification;
	return (
		notification == null ||
		(typeof notification.user_id === "string" &&
			notification.user_id.length > 0 &&
			isNotificationType(notification.notification_type) &&
			typeof notification.title === "string" &&
			notification.title.length > 0 &&
			typeof notification.body === "string" &&
			notification.body.length > 0)
	);
}

export async function consumePublishQueue(
	batch: MessageBatch<PublishMessage>,
	env: Env,
): Promise<void> {
	await mapConcurrently(
		batch.messages,
		PUBLISH_CONCURRENCY,
		async (message) => {
			const body = message.body as PublishMessage | null;

			if (
				body &&
				(body.type === "publish_thread" ||
					body.type === "publish_thread_item") &&
				body.org_id &&
				body.thread_group_id
			) {
				await handleThreadPublish(
					message,
					body as PublishMessage & { org_id: string; thread_group_id: string },
					env,
				);
			} else if (body?.type === "publish" && body.post_id && body.org_id) {
				await handlePostPublish(
					message,
					body as PublishMessage & { post_id: string; org_id: string },
					env,
				);
			} else if (isPostCompletionMessage(body)) {
				await handlePostCompletion(message, body, env);
			} else if (
				body?.type === "send_notification" &&
				body.org_id &&
				isNotificationType(body.notification_type) &&
				body.title &&
				body.body &&
				body.occurrence_id
			) {
				await handleNotification(
					message,
					body as PublishMessage & {
						org_id: string;
						notification_type: NotificationType;
						title: string;
						body: string;
						occurrence_id: string;
					},
					env,
				);
			} else {
				await recordQueueFailure(
					env,
					batch.queue,
					message,
					"permanent_input",
					"Malformed or unsupported publish queue message",
				);
				message.ack();
			}
		},
	);
	try {
		await dispatchPublishOutbox(env);
	} catch (error) {
		// Terminal follow-ups are already durable. The every-minute drain retries
		// them without replaying provider publishes from this completed batch.
		console.error("[Publish queue] Durable follow-up dispatch deferred", error);
	}
}

async function handlePostCompletion(
	message: Message<PublishMessage>,
	body: PublishMessage & {
		post_id: string;
		org_id: string;
		occurrence_id: string;
		occurred_at: string;
		update_streak: boolean;
	},
	env: Env,
): Promise<void> {
	try {
		if (body.update_streak) {
			await updateStreak(
				env,
				createDb(env.HYPERDRIVE.connectionString),
				body.org_id,
				new Date(body.occurred_at),
			);
		}
		if (body.notification) {
			await sendNotification(env, {
				type: body.notification.notification_type,
				orgId: body.org_id,
				userId: body.notification.user_id,
				title: body.notification.title,
				body: body.notification.body,
				data: body.notification.data,
				occurrenceId: body.occurrence_id,
			});
		}
		message.ack();
	} catch (error) {
		console.error(
			`Post completion effects ${body.occurrence_id} failed:`,
			error instanceof Error ? error.message : "unknown error",
		);
		message.retry({ delaySeconds: 2 ** message.attempts });
	}
}

async function handleNotification(
	message: Message<PublishMessage>,
	body: PublishMessage & {
		org_id: string;
		notification_type: NotificationType;
		title: string;
		body: string;
		occurrence_id: string;
	},
	env: Env,
): Promise<void> {
	try {
		const params = {
			type: body.notification_type,
			orgId: body.org_id,
			title: body.title,
			body: body.body,
			data: body.data,
			occurrenceId: body.occurrence_id,
		};
		if (body.user_id) {
			await sendNotification(env, { ...params, userId: body.user_id });
		} else {
			await sendNotificationToOrg(env, params);
		}
		message.ack();
	} catch (error) {
		console.error(
			`Notification job ${body.occurrence_id} failed:`,
			error instanceof Error ? error.message : "unknown error",
		);
		message.retry({ delaySeconds: 2 ** message.attempts });
	}
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

		// Any next-position handoff was committed to publish_outbox in the same
		// transaction that released the execution lease. No direct Queue send is
		// needed here, so ACK cannot strand a queued thread on isolate cancellation.
		message.ack();
	} catch (err) {
		console.error(`Thread publish failed for ${body.thread_group_id}:`, err);
		// Explicit retry is required; a successful handler return would otherwise
		// ACK the message. Wrangler moves exhausted work to relayapi-publish-dlq.
		message.retry({ delaySeconds: 2 ** message.attempts });
	}
}

async function handlePostPublish(
	message: Message<PublishMessage>,
	body: PublishMessage & { post_id: string; org_id: string },
	env: Env,
): Promise<void> {
	try {
		await publishPostById(env, body.post_id, body.org_id);

		// The Queue handoff is a required follow-up. Await it before ACK so a
		// cancelled isolate cannot silently drop the first metrics collection.
		await scheduleFirstMetricsRefresh(env, body.post_id, body.org_id);

		message.ack();
	} catch (err) {
		console.error(`Queue publish failed for ${body.post_id}:`, err);
		message.retry({ delaySeconds: 2 ** message.attempts });
	}
}
