import { beforeEach, describe, expect, it, mock } from "bun:test";

const streakCalls: Array<{ orgId: string; occurredAt: Date }> = [];
const notificationCalls: Array<Record<string, unknown>> = [];
let notificationError: Error | null = null;

mock.module("@relayapi/db", () => ({
	createDb: () => ({ kind: "test-db", execute: async () => [] }),
	publishOutbox: {},
}));
mock.module("../services/streak", () => ({
	updateStreak: async (
		_env: unknown,
		_db: unknown,
		orgId: string,
		occurredAt: Date,
	) => {
		streakCalls.push({ orgId, occurredAt });
	},
}));
mock.module("../services/notification-manager", () => ({
	sendNotification: async (_env: unknown, input: Record<string, unknown>) => {
		notificationCalls.push(input);
		if (notificationError) throw notificationError;
	},
	sendNotificationToOrg: async () => {},
}));
mock.module("../services/publisher-runner", () => ({
	publishPostById: async () => {},
}));
mock.module("../services/analytics-refresh", () => ({
	scheduleFirstMetricsRefresh: async () => {},
}));
mock.module("../middleware/usage-tracking", () => ({
	incrementUsage: async () => {},
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure: async () => {},
}));

const { consumePublishQueue } = await import("../queues/publish");

function completionMessage(attempts = 1) {
	let acked = false;
	let retryDelay: number | null = null;
	const message = {
		id: "completion-message",
		attempts,
		timestamp: new Date(0),
		body: {
			type: "post_completion_effects",
			post_id: "post_1",
			org_id: "org_1",
			status: "published" as const,
			occurred_at: "2026-07-13T12:00:00.000Z",
			occurrence_id: "post:post_1:publish:lease_1:published",
			update_streak: true,
			notification: {
				user_id: "user_1",
				notification_type: "post_published" as const,
				title: "Post published successfully",
				body: "Your post was published",
				data: { postId: "post_1" },
			},
		},
		ack: () => {
			acked = true;
		},
		retry: (options?: { delaySeconds?: number }) => {
			retryDelay = options?.delaySeconds ?? 0;
		},
	};
	return {
		message,
		state: () => ({ acked, retryDelay }),
	};
}

describe("post completion Queue effects", () => {
	beforeEach(() => {
		streakCalls.length = 0;
		notificationCalls.length = 0;
		notificationError = null;
	});

	it("applies streak and notification work before ACK", async () => {
		const { message, state } = completionMessage();
		await consumePublishQueue(
			{
				queue: "relayapi-publish",
				messages: [message],
			} as unknown as Parameters<typeof consumePublishQueue>[0],
			{
				HYPERDRIVE: { connectionString: "postgres://test" },
			} as never,
		);

		expect(streakCalls).toEqual([
			{ orgId: "org_1", occurredAt: new Date("2026-07-13T12:00:00.000Z") },
		]);
		expect(notificationCalls).toHaveLength(1);
		expect(notificationCalls[0]).toMatchObject({
			orgId: "org_1",
			userId: "user_1",
			occurrenceId: "post:post_1:publish:lease_1:published",
		});
		expect(state()).toEqual({ acked: true, retryDelay: null });
	});

	it("retries the same durable effect when notification delivery fails", async () => {
		notificationError = new Error("temporary notification outage");
		const { message, state } = completionMessage(3);
		await consumePublishQueue(
			{
				queue: "relayapi-publish",
				messages: [message],
			} as unknown as Parameters<typeof consumePublishQueue>[0],
			{
				HYPERDRIVE: { connectionString: "postgres://test" },
			} as never,
		);

		expect(streakCalls).toHaveLength(1);
		expect(state()).toEqual({ acked: false, retryDelay: 8 });
	});
});
