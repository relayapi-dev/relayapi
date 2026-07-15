import { beforeEach, describe, expect, it, mock } from "bun:test";

let receiptStatus: string | null = null;
const failureCalls: Array<{ kind: string; error: string }> = [];

const columns = (...names: string[]) =>
	Object.fromEntries(names.map((name) => [name, { name }]));

const db = {
	update: () => ({
		set: () => ({
			where: () => ({ returning: async () => [] }),
		}),
	}),
	select: () => ({
		from: () => ({
			where: () => ({
				limit: async () =>
					receiptStatus === null ? [] : [{ status: receiptStatus }],
			}),
		}),
	}),
};

mock.module("@relayapi/db", () => ({
	createDb: () => db,
	inboundWebhookEvents: columns(
		"id",
		"status",
		"claimedAt",
		"attempts",
		"organizationIds",
	),
	organization: columns("id", "lifecycleStatus"),
}));
mock.module("../services/inbox-event-processor", () => ({
	processInboxEvent: async () => {},
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure: async (
		_env: unknown,
		_queue: string,
		_message: unknown,
		kind: string,
		error: string,
	) => {
		failureCalls.push({ kind, error });
	},
}));

const { consumeInboxQueue } = await import("../queues/inbox");

function rawReceiptMessage() {
	let acknowledgements = 0;
	let retries = 0;
	const message = {
		id: "queue_message_1",
		timestamp: new Date(),
		attempts: 1,
		body: {
			type: "raw_platform_webhook",
			receipt_id: "iwe_missing",
			received_at: "2026-07-13T00:00:00.000Z",
		},
		ack: () => {
			acknowledgements++;
		},
		retry: () => {
			retries++;
		},
	};
	return {
		message,
		state: () => ({ acknowledgements, retries }),
	};
}

function batch(message: ReturnType<typeof rawReceiptMessage>["message"]) {
	return {
		queue: "relayapi-inbox",
		messages: [message],
	} as unknown as Parameters<typeof consumeInboxQueue>[0];
}

describe("raw inbox receipt Queue validation", () => {
	beforeEach(() => {
		receiptStatus = null;
		failureCalls.length = 0;
	});

	it("records a nonexistent durable receipt before ACK", async () => {
		const { message, state } = rawReceiptMessage();
		await consumeInboxQueue(batch(message), {
			HYPERDRIVE: { connectionString: "postgres://test" },
		} as never);

		expect(state()).toEqual({ acknowledgements: 1, retries: 0 });
		expect(failureCalls).toEqual([
			{
				kind: "permanent_input",
				error: "Raw inbox receipt iwe_missing does not exist",
			},
		]);
	});

	it("ACKs a known receipt already owned by another worker without a failure", async () => {
		receiptStatus = "processing";
		const { message, state } = rawReceiptMessage();
		await consumeInboxQueue(batch(message), {
			HYPERDRIVE: { connectionString: "postgres://test" },
		} as never);

		expect(state()).toEqual({ acknowledgements: 1, retries: 0 });
		expect(failureCalls).toEqual([]);
	});
});
