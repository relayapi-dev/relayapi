import { beforeEach, describe, expect, it, mock } from "bun:test";

let delivery: "ack" | "retry" = "ack";
let acked = 0;
let retried = 0;
let executed = 0;

mock.module("../services/tool-jobs", () => ({
	claimToolJob: async () => ({
		id: "tj_1",
		organizationId: "org_1",
		kind: "download",
		request: { url: "https://example.test/video" },
		attempts: 1,
		leaseToken: 1,
		deadlineAt: new Date(Date.now() + 60_000),
		usageReservation: {
			id: "ur_1",
			bucketId: "ub_1",
			organizationId: "org_1",
		},
	}),
	executeClaimedToolJob: async () => {
		executed += 1;
		return delivery === "retry"
			? {
					delivery: "retry" as const,
					outcome: "deferred" as const,
					delaySeconds: 4,
				}
			: {
					delivery: "ack" as const,
					outcome: "completed" as const,
					data: { success: true },
				};
	},
}));

const { consumeToolsQueue } = await import("../queues/tools");

import type { Env } from "../types";

describe("tools Queue settled-result handling", () => {
	beforeEach(() => {
		delivery = "ack";
		acked = 0;
		retried = 0;
		executed = 0;
	});

	function messageAndBatch() {
		const retryDelays: number[] = [];
		const message: Message<{
			type: "tool_job";
			job_id: string;
			org_id: string;
		}> = {
			id: "msg_tool",
			timestamp: new Date(),
			attempts: 1,
			body: {
				type: "tool_job",
				job_id: "tj_1",
				org_id: "org_1",
			},
			ack: () => {
				acked += 1;
			},
			retry: (options) => {
				retried += 1;
				if (options?.delaySeconds !== undefined) {
					retryDelays.push(options.delaySeconds);
				}
			},
		};
		const batch = {
			messages: [message],
			queue: "relayapi-tools",
			metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
			ackAll: () => {},
			retryAll: () => {},
		} satisfies MessageBatch<typeof message.body>;
		return { message, batch, retryDelays };
	}

	it("acks a terminal result from the shared fenced executor", async () => {
		const { message, batch } = messageAndBatch();

		await consumeToolsQueue(batch, {} as Env);

		expect(executed).toBe(1);
		expect(acked).toBe(1);
		expect(retried).toBe(0);
		expect(message.body).toEqual({
			type: "tool_job",
			job_id: "tj_1",
			org_id: "org_1",
		});
	});

	it("retries only when the executor durably deferred before egress", async () => {
		delivery = "retry";
		const { batch, retryDelays } = messageAndBatch();

		await consumeToolsQueue(batch, {} as Env);

		expect(executed).toBe(1);
		expect(acked).toBe(0);
		expect(retried).toBe(1);
		expect(retryDelays).toEqual([4]);
	});
});
