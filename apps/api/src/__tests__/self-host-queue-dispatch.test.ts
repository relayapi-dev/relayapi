import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	deploymentQueueNames,
	normalizeQueueClass,
	WORK_QUEUE_CAPABILITIES,
} from "../queues/queue-class";
import type { Env } from "../types";

let consumerCalls: string[] = [];

function recordConsumer(name: string) {
	return async () => {
		consumerCalls.push(name);
	};
}

mock.module("../queues/ads", () => ({
	consumeAdsQueue: recordConsumer("ads"),
}));
mock.module("../queues/customer-webhook", () => ({
	consumeCustomerWebhookQueue: recordConsumer("customer-webhooks"),
}));
mock.module("../queues/dead-letter", () => ({
	consumeDeadLetterQueue: recordConsumer("dead-letter"),
}));
mock.module("../queues/email", () => ({
	consumeEmailQueue: recordConsumer("email"),
}));
mock.module("../queues/inbox", () => ({
	consumeInboxQueue: recordConsumer("inbox"),
}));
mock.module("../queues/media-cleanup", () => ({
	consumeMediaCleanupQueue: recordConsumer("media-cleanup"),
}));
mock.module("../queues/publish", () => ({
	consumePublishQueue: recordConsumer("publish"),
}));
mock.module("../queues/queue-rescue", () => ({
	consumeQueueRescue: recordConsumer("queue-rescue"),
}));
mock.module("../queues/sync", () => ({
	consumeSyncQueue: recordConsumer("sync"),
}));
mock.module("../queues/token-refresh", () => ({
	consumeTokenRefreshQueue: recordConsumer("refresh"),
}));
mock.module("../queues/tools", () => ({
	consumeToolsQueue: recordConsumer("tools"),
}));

const { handleQueueBatch } = await import("../queues");

function batch(queue: string): MessageBatch {
	return {
		queue,
		messages: [],
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll: () => {},
		retryAll: () => {},
	};
}

beforeEach(() => {
	consumerCalls = [];
});

describe("self-host Queue dispatch", () => {
	it("dispatches every self-host source Queue by canonical capability", async () => {
		for (const capability of WORK_QUEUE_CAPABILITIES) {
			await handleQueueBatch(
				batch(`relayapi-selfhost-${capability}`),
				{} as Env,
			);
			expect(consumerCalls.pop()).toBe(capability);
		}
		expect(consumerCalls).toEqual([]);
	});

	it("dispatches every self-host DLQ and the rescue Queue", async () => {
		for (const capability of WORK_QUEUE_CAPABILITIES) {
			await handleQueueBatch(
				batch(`relayapi-selfhost-${capability}-dlq`),
				{} as Env,
			);
			expect(consumerCalls.pop()).toBe("dead-letter");
		}

		await handleQueueBatch(batch("relayapi-selfhost-queue-rescue"), {} as Env);
		expect(consumerCalls).toEqual(["queue-rescue"]);
	});

	it("rejects unregistered names instead of accepting an arbitrary prefix", async () => {
		await expect(
			handleQueueBatch(batch("relayapi-selfhost-publish-shadow"), {} as Env),
		).rejects.toThrow(
			"No queue consumer registered for relayapi-selfhost-publish-shadow",
		);
	});
});

describe("canonical Queue class normalization", () => {
	it("normalizes hosted and self-hosted sources, DLQs, rescue, and inbox-raw", () => {
		for (const capability of WORK_QUEUE_CAPABILITIES) {
			expect(normalizeQueueClass(`relayapi-${capability}`)).toEqual({
				capability,
				role: "source",
			});
			expect(normalizeQueueClass(`relayapi-selfhost-${capability}`)).toEqual({
				capability,
				role: "source",
			});
			expect(normalizeQueueClass(`relayapi-${capability}-dlq`)).toEqual({
				capability,
				role: "dead-letter",
			});
			expect(
				normalizeQueueClass(`relayapi-selfhost-${capability}-dlq`),
			).toEqual({
				capability,
				role: "dead-letter",
			});
		}
		expect(normalizeQueueClass("relayapi-selfhost-queue-rescue")).toEqual({
			capability: "queue-rescue",
			role: "rescue",
		});
		expect(normalizeQueueClass("relayapi-inbox-raw")).toEqual({
			capability: "inbox",
			role: "source",
		});
	});

	it("provides both physical names for ledger selectors", () => {
		expect(
			deploymentQueueNames({
				capability: "media-cleanup",
				role: "dead-letter",
			}),
		).toEqual([
			"relayapi-selfhost-media-cleanup-dlq",
			"relayapi-media-cleanup-dlq",
		]);
	});
});
