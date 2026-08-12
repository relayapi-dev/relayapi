import { beforeEach, describe, expect, it, mock } from "bun:test";

const processed: Array<Record<string, unknown>> = [];
let processingError: unknown;
let recordedFailure: string | null = null;

mock.module("../services/ad-report-jobs", () => ({
	processAdvancedAdReportJob: async (
		_env: unknown,
		input: Record<string, unknown>,
	) => {
		processed.push(input);
		if (processingError) throw processingError;
	},
}));
mock.module("../services/ad-sync", () => ({
	syncAdMetrics: async () => {},
	syncExternalAds: async () => {},
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure: async (
		_env: unknown,
		_queue: string,
		_message: unknown,
		kind: string,
	) => {
		recordedFailure = kind;
	},
}));

const { consumeAdsQueue } = await import("../queues/ads");

import type { Env } from "../types";

function trackedMessage(body: Record<string, unknown>, attempts = 1) {
	let acked = 0;
	let retries = 0;
	let delaySeconds: number | undefined;
	const message = {
		id: "advanced_report_queue_1",
		timestamp: new Date(),
		attempts,
		body,
		ack: () => {
			acked++;
		},
		retry: (options?: { delaySeconds?: number }) => {
			retries++;
			delaySeconds = options?.delaySeconds;
		},
	} as Message<Record<string, unknown>>;
	return {
		message,
		acked: () => acked,
		retries: () => retries,
		delay: () => delaySeconds,
	};
}

function batch(message: Message<Record<string, unknown>>): MessageBatch<never> {
	return {
		messages: [message as Message<never>],
		queue: "relayapi-ads",
		metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
		ackAll: () => {},
		retryAll: () => {},
	};
}

describe("advanced ad report Queue dispatch", () => {
	beforeEach(() => {
		processed.length = 0;
		processingError = undefined;
		recordedFailure = null;
	});

	it("passes only durable tenant and job identifiers to the processor", async () => {
		const tracked = trackedMessage({
			type: "advanced_report",
			org_id: "org_1",
			report_job_id: "adrep_1",
		});
		await consumeAdsQueue(batch(tracked.message), {} as Env);

		expect(processed).toEqual([
			{ organizationId: "org_1", reportJobId: "adrep_1" },
		]);
		expect(tracked.acked()).toBe(1);
		expect(tracked.retries()).toBe(0);
	});

	it("rejects provider parameters embedded in the Queue message", async () => {
		const tracked = trackedMessage({
			type: "advanced_report",
			org_id: "org_1",
			report_job_id: "adrep_1",
			request: { access_token: "must-not-cross-queue" },
		});
		await consumeAdsQueue(batch(tracked.message), {} as Env);

		expect(processed).toEqual([]);
		expect(recordedFailure).toBe("permanent_input");
		expect(tracked.acked()).toBe(1);
	});

	it("uses bounded Queue retry delay for an infrastructure failure", async () => {
		processingError = new Error("temporary database outage");
		const tracked = trackedMessage(
			{
				type: "advanced_report",
				org_id: "org_1",
				report_job_id: "adrep_1",
			},
			2,
		);
		await consumeAdsQueue(batch(tracked.message), {} as Env);

		expect(tracked.acked()).toBe(0);
		expect(tracked.retries()).toBe(1);
		expect(tracked.delay()).toBe(5);
	});
});
