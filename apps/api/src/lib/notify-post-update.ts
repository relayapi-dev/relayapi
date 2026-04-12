import type { Env } from "../types";

export type PostEvent =
	| { type: "post.updated"; post_id: string; status: string }
	| { type: "post.deleted"; post_id: string }
	| { type: "post.created"; post_id: string; status: string };

export type InboxEvent =
	| { type: "inbox.comment.received"; post_id?: string; platform?: string }
	| { type: "inbox.comment.replied"; post_id?: string; comment_id?: string }
	| { type: "inbox.comment.deleted"; comment_id: string }
	| { type: "inbox.comment.hidden"; comment_id: string; hidden: boolean }
	| { type: "inbox.comment.liked"; comment_id: string }
	| { type: "inbox.message.received"; conversation_id?: string; platform?: string }
	| { type: "inbox.message.sent"; conversation_id?: string }
	| { type: "inbox.updated" };

export type NotificationEvent =
	| { type: "notification.created" };

export type BroadcastEvent =
	| { type: "broadcast.updated"; broadcast_id: string; status: string };

export type StreakEvent =
	| { type: "streak.updated"; current_streak_days: number; last_post_at: string }
	| { type: "streak.milestone"; current_streak_days: number }
	| { type: "streak.broken"; broken_streak_days: number };

export type RealtimeEvent = PostEvent | InboxEvent | NotificationEvent | BroadcastEvent | StreakEvent;

/**
 * Notify the RealtimeDO for an org about a dashboard event.
 * The DO broadcasts the event to all connected WebSocket clients.
 * Errors are logged but never thrown — this is fire-and-forget.
 */
export async function notifyRealtime(
	env: Env,
	orgId: string,
	event: RealtimeEvent,
): Promise<void> {
	try {
		const doId = env.REALTIME.idFromName(orgId);
		const stub = env.REALTIME.get(doId);
		await stub.fetch("http://internal/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
		});
	} catch (err) {
		console.error("[Realtime] Failed to notify DO:", err);
	}
}

/** @deprecated Use notifyRealtime instead */
export const notifyPostUpdate = notifyRealtime;
