import { describe, expect, it, mock } from "bun:test";

mock.module("../services/tool-service", () => ({
	callDownloaderService: async () => {
		throw new Error("downloader unavailable");
	},
}));
mock.module("../services/tool-jobs", () => ({
	completeToolJob: async () => {},
	failToolJob: async () => {
		throw new Error("KV terminal write unavailable");
	},
}));

const { consumeToolsQueue } = await import("../queues/tools");

import type { Env } from "../types";

describe("tools Queue settled-result handling", () => {
	it("retries a message when terminal-state persistence rejects", async () => {
		let acked = 0;
		let retried = 0;
		const message: Message<{
			type: "tool_download";
			job_id: string;
			org_id: string;
			endpoint: string;
			payload: Record<string, unknown>;
		}> = {
			id: "msg_tool",
			timestamp: new Date(),
			attempts: 3,
			body: {
				type: "tool_download",
				job_id: "tj_1",
				org_id: "org_1",
				endpoint: "/download",
				payload: { url: "https://example.com/video" },
			},
			ack: () => {
				acked += 1;
			},
			retry: () => {
				retried += 1;
			},
		};
		const batch = {
			messages: [message],
			queue: "relayapi-tools",
			metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
			ackAll: () => {},
			retryAll: () => {},
		} satisfies MessageBatch<typeof message.body>;

		await consumeToolsQueue(batch, {} as Env);

		expect(acked).toBe(0);
		expect(retried).toBe(1);
	});
});
