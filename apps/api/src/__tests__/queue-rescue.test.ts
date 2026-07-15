import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	consumeQueueRescue,
	createQueueRescueEnvelope,
	persistQueueRescue,
} from "../queues/queue-rescue";
import type { Env } from "../types";

function queueMessage(body: unknown, attempts = 1) {
	let acknowledgements = 0;
	let retries = 0;
	const message: Message<unknown> = {
		id: "msg_test",
		timestamp: new Date("2026-07-13T12:00:00.000Z"),
		body,
		attempts,
		ack: () => {
			acknowledgements += 1;
		},
		retry: () => {
			retries += 1;
		},
	};
	return {
		message,
		acknowledgements: () => acknowledgements,
		retries: () => retries,
	};
}

function queueBatch(message: Message<unknown>): MessageBatch<unknown> {
	return {
		messages: [message],
		queue: "relayapi-queue-rescue",
		metadata: {
			metrics: { backlogCount: 1, backlogBytes: 1 },
		},
		retryAll: () => {},
		ackAll: () => {},
	};
}

function envWithRescuePut(
	put: (
		key: string,
		value: string | ReadableStream | ArrayBuffer | ArrayBufferView,
	) => Promise<unknown>,
): Env {
	return {
		QUEUE_RESCUE_BUCKET: { put } as R2Bucket,
	} as Env;
}

describe("queue rescue ledger", () => {
	it("uses a deterministic object key so redelivery does not multiply records", async () => {
		const keys: string[] = [];
		const env = envWithRescuePut(async (key) => {
			keys.push(key);
			return null;
		});
		const { message } = queueMessage({
			organization_id: "org_test",
			post_id: "post_1",
		});
		const envelope = createQueueRescueEnvelope("relayapi-publish-dlq", message);

		await persistQueueRescue(env, envelope);
		await persistQueueRescue(env, envelope);

		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).toContain(
			"by-organization/org_test/relayapi-publish-dlq/msg_test.json",
		);
	});

	it("redacts bodies that cannot be assigned to exactly one tenant", () => {
		const { message } = queueMessage({
			organization_ids: ["org_a", "org_b"],
			post_id: "post_1",
			private_body: "not safe to retain in an unscoped object",
		});

		const envelope = createQueueRescueEnvelope("relayapi-publish-dlq", message);

		expect(envelope.organizationIds).toEqual([]);
		expect(envelope.body).toEqual({
			redacted: true,
			reason: "multiple_tenant_scope",
			operation_id: "post_1",
		});
	});

	it("derives media-event tenant scope from the object key", () => {
		const body = {
			account: "cf-account",
			bucket: "relayapi-media",
			action: "PutObject",
			object: { key: "org_media/uploads/photo.jpg" },
		};
		const { message } = queueMessage(body);

		const envelope = createQueueRescueEnvelope(
			"relayapi-media-cleanup-dlq",
			message,
		);

		expect(envelope.organizationIds).toEqual(["org_media"]);
		expect(envelope.body).toEqual(body);
	});

	it("ACKs only after the rescue object is durable", async () => {
		const writes: string[] = [];
		const env = envWithRescuePut(async (key) => {
			writes.push(key);
			return null;
		});
		const tracked = queueMessage({ broken: true });

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(writes).toHaveLength(1);
		expect(tracked.acknowledgements()).toBe(1);
		expect(tracked.retries()).toBe(0);
	});

	it("retries instead of acknowledging when R2 is unavailable", async () => {
		const env = envWithRescuePut(async () => {
			throw new Error("R2 unavailable");
		});
		const tracked = queueMessage({ broken: true }, 3);

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(tracked.acknowledgements()).toBe(0);
		expect(tracked.retries()).toBe(1);
	});

	it("renews its delivery budget before the finite retry limit", async () => {
		let handoffs = 0;
		const tracked = queueMessage(
			{ organization_id: "org_test", post_id: "post_1" },
			95,
		);
		const env = {
			QUEUE_RESCUE_BUCKET: {
				put: async () => {
					throw new Error("R2 unavailable");
				},
			},
			QUEUE_RESCUE_QUEUE: {
				send: async () => {
					handoffs += 1;
				},
			},
		} as unknown as Env;

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(handoffs).toBe(1);
		expect(tracked.acknowledgements()).toBe(1);
		expect(tracked.retries()).toBe(0);
	});
});

describe("queue reliability regression guards", () => {
	it("routes every business DLQ into the independent rescue queue", () => {
		const config = readFileSync(
			new URL("../../wrangler.jsonc", import.meta.url),
			"utf8",
		);
		for (const queue of [
			"media-cleanup",
			"publish",
			"email",
			"refresh",
			"inbox",
			"tools",
			"ads",
			"sync",
			"customer-webhooks",
		]) {
			const consumer = new RegExp(
				`"queue":\\s*"relayapi-${queue}-dlq"[\\s\\S]*?"dead_letter_queue":\\s*"relayapi-queue-rescue"`,
			);
			expect(config).toMatch(consumer);
		}
		expect(config).toContain('"binding": "QUEUE_RESCUE_BUCKET"');
	});

	it("keeps replay claims fenced across the Queue send boundary", () => {
		const source = readFileSync(
			new URL("../services/queue-replay.ts", import.meta.url),
			"utf8",
		);
		const claim = source.indexOf('status: "replay_claimed"');
		const send = source.indexOf("await queue.send(replayPayload)");
		const ambiguous = source.indexOf('status: "replay_unknown"', send);
		expect(claim).toBeGreaterThan(-1);
		expect(send).toBeGreaterThan(claim);
		expect(ambiguous).toBeGreaterThan(send);
		expect(source).not.toContain('set({ status: "unresolved"');
		const rawReceiptReset = source.slice(
			source.indexOf("if (rawReceiptId) {", source.indexOf("try {")),
			source.indexOf("// Customer deliveries use", source.indexOf("try {")),
		);
		expect(source).toContain('receipt?.status !== "failed"');
		expect(rawReceiptReset).toContain(
			'eq(inboundWebhookEvents.status, "failed")',
		);
		expect(source).toContain("candidate.organizationIds.length !== 1");
		expect(rawReceiptReset).toContain(
			"inboundWebhookEvents.organizationIds} = ARRAY[$" +
				"{organizationId}]::text[]",
		);
	});

	it("fences duplicate email workers with the durable claim timestamp", () => {
		const source = readFileSync(
			new URL("../queues/email.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("EMAIL_CLAIM_MS");
		expect(source).toContain(
			"eq(emailDeliveries.requestMayHaveBeenSentAt, claim.claimAt)",
		);
		expect(source).toContain('claim.state === "busy"');
		expect(source).toContain("requestMayHaveBeenSentAt: null");
	});
});
