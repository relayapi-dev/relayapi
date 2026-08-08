import { describe, expect, it, mock } from "bun:test";

mock.module("@relayapi/db", () => ({
	createDb: () => {
		throw new Error("PostgreSQL unavailable");
	},
	inboundWebhookEvents: {},
	organization: {},
	queueFailures: {},
	socialAccounts: {},
}));
mock.module("../services/operator-alerts", () => ({
	dispatchQueueRescuePersistenceAlert: async () => {},
}));

const { consumeDeadLetterQueue } = await import("../queues/dead-letter");

import type { Env } from "../types";

const TEST_ENCRYPTION_KEY = `test=${"a".repeat(64)}`;

function message() {
	let acked = 0;
	let retried = 0;
	const value: Message<unknown> = {
		id: "msg_dlq",
		timestamp: new Date(),
		attempts: 3,
		body: { org_id: "org_1", post_id: "post_1" },
		ack: () => {
			acked += 1;
		},
		retry: () => {
			retried += 1;
		},
	};
	return { value, acked: () => acked, retried: () => retried };
}

function batch(value: Message<unknown>): MessageBatch<unknown> {
	return {
		messages: [value],
		queue: "relayapi-publish-dlq",
		metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
		ackAll: () => {},
		retryAll: () => {},
	};
}

describe("DLQ independent rescue fallback", () => {
	it("persists to R2 and ACKs when PostgreSQL is down", async () => {
		let writes = 0;
		const tracked = message();
		const env = {
			HYPERDRIVE: { connectionString: "postgres://unavailable" },
			ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			QUEUE_RESCUE_BUCKET: {
				put: async () => {
					writes += 1;
					return null;
				},
			},
		} as unknown as Env;

		await consumeDeadLetterQueue(batch(tracked.value), env);

		expect(writes).toBe(1);
		expect(tracked.acked()).toBe(1);
		expect(tracked.retried()).toBe(0);
	});

	it("hands off to the rescue queue when both Postgres and R2 are unavailable", async () => {
		let rescueSends = 0;
		const tracked = message();
		const env = {
			HYPERDRIVE: { connectionString: "postgres://unavailable" },
			ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			QUEUE_RESCUE_BUCKET: {
				put: async () => {
					throw new Error("R2 unavailable");
				},
			},
			QUEUE_RESCUE_QUEUE: {
				send: async () => {
					rescueSends += 1;
				},
			},
		} as unknown as Env;

		await consumeDeadLetterQueue(batch(tracked.value), env);

		expect(rescueSends).toBe(1);
		expect(tracked.acked()).toBe(1);
		expect(tracked.retried()).toBe(0);
	});
});
