import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

const events: string[] = [];
const errorSpy = spyOn(console, "error").mockImplementation(() => {});
let deliveryResult: "succeeded" | "unknown" = "succeeded";
let deliveryError: Error | null = null;
let deliveryGate: Promise<void> | null = null;
let activeDeliveries = 0;
let maxActiveDeliveries = 0;

const performWebhookDelivery = mock(async () => {
	activeDeliveries++;
	maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
	try {
		if (deliveryGate) await deliveryGate;
		if (deliveryError) throw deliveryError;
		return deliveryResult;
	} finally {
		activeDeliveries--;
	}
});
const recordQueueFailure = mock(
	async (_env: unknown, _queue: string, _message: unknown, kind: string) => {
		events.push(`failure:${kind}`);
	},
);
const recordQueueFailureRecord = mock(
	async (_env: unknown, input: { kind: string }) => {
		events.push(`failure:${input.kind}`);
	},
);

mock.module("../services/webhook-delivery", () => ({
	performWebhookDelivery,
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure,
	recordQueueFailureRecord,
}));

const { consumeCustomerWebhookQueue } = await import(
	"../queues/customer-webhook"
);

import type { CustomerWebhookQueueMessage } from "../services/webhook-delivery";
import type { Env } from "../types";

function message(body: unknown) {
	return {
		id: "msg_1",
		timestamp: new Date(),
		attempts: 2,
		body,
		ack: () => events.push("ack"),
		retry: (options?: { delaySeconds?: number }) =>
			events.push(`retry:${options?.delaySeconds ?? 0}`),
	};
}

function batch(body: unknown) {
	return {
		queue: "relayapi-customer-webhooks",
		messages: [message(body)],
	} as unknown as MessageBatch<CustomerWebhookQueueMessage>;
}

const validBody: CustomerWebhookQueueMessage = {
	type: "deliver_customer_webhook",
	delivery_id: "whd_1",
	operation_id: "whd_1",
	organization_id: "org_1",
};

beforeEach(() => {
	events.length = 0;
	deliveryResult = "succeeded";
	deliveryError = null;
	deliveryGate = null;
	activeDeliveries = 0;
	maxActiveDeliveries = 0;
	performWebhookDelivery.mockClear();
	recordQueueFailure.mockClear();
	recordQueueFailureRecord.mockClear();
});

afterAll(() => errorSpy.mockRestore());

describe("customer webhook Queue consumer", () => {
	it("persists an unknown outcome before acknowledging", async () => {
		deliveryResult = "unknown";
		await consumeCustomerWebhookQueue(batch(validBody), {} as Env);

		expect(events).toEqual(["failure:unknown_external_outcome", "ack"]);
		expect(recordQueueFailureRecord).toHaveBeenCalledTimes(1);
		expect(recordQueueFailureRecord.mock.calls[0]?.[1]).toMatchObject({
			messageId: "delivery:whd_1",
			organizationIds: ["org_1"],
			operationId: "whd_1",
		});
	});

	it("retries infrastructure failures without acknowledging", async () => {
		deliveryError = new Error("database unavailable");
		await consumeCustomerWebhookQueue(batch(validBody), {} as Env);

		expect(events).toEqual(["retry:4"]);
	});

	it("records malformed input before acknowledging", async () => {
		const invalid = { ...validBody, delivery_id: "" };
		await consumeCustomerWebhookQueue(batch(invalid), {} as Env);

		expect(events).toEqual(["failure:permanent_input", "ack"]);
		expect(performWebhookDelivery).not.toHaveBeenCalled();
	});

	it("rejects messages without an organization instead of inferring one", async () => {
		const invalid = {
			type: validBody.type,
			delivery_id: validBody.delivery_id,
			operation_id: validBody.operation_id,
		};
		await consumeCustomerWebhookQueue(batch(invalid), {} as Env);

		expect(events).toEqual(["failure:permanent_input", "ack"]);
		expect(performWebhookDelivery).not.toHaveBeenCalled();
	});

	it("records a non-object body before acknowledging", async () => {
		await consumeCustomerWebhookQueue(batch(null), {} as Env);

		expect(events).toEqual(["failure:permanent_input", "ack"]);
		expect(performWebhookDelivery).not.toHaveBeenCalled();
	});

	it("bounds local delivery concurrency for a full ten-message batch", async () => {
		let releaseDeliveries!: () => void;
		deliveryGate = new Promise<void>((resolve) => {
			releaseDeliveries = resolve;
		});
		const messages = Array.from({ length: 10 }, (_, index) =>
			message({
				...validBody,
				delivery_id: `whd_${index}`,
				operation_id: `whd_${index}`,
			}),
		);
		const consumption = consumeCustomerWebhookQueue(
			{
				queue: "relayapi-customer-webhooks",
				messages,
			} as unknown as MessageBatch<CustomerWebhookQueueMessage>,
			{} as Env,
		);

		// Five local workers reach the gate; the remaining messages stay queued
		// inside this invocation while Queue batches can scale horizontally.
		await Promise.resolve();
		await Promise.resolve();
		expect(performWebhookDelivery).toHaveBeenCalledTimes(5);
		expect(maxActiveDeliveries).toBe(5);

		releaseDeliveries();
		await consumption;

		expect(performWebhookDelivery).toHaveBeenCalledTimes(10);
		expect(maxActiveDeliveries).toBe(5);
		expect(events.filter((event) => event === "ack")).toHaveLength(10);
		expect(events.some((event) => event.startsWith("retry:"))).toBe(false);
	});
});
