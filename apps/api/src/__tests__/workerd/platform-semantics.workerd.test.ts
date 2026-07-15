/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
	createExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { type RealtimeDO } from "../../index";
import { replayBodyForStatus } from "../../middleware/idempotency";
import { consumeQueueRescue } from "../../queues/queue-rescue";
import { isMediaEventMessage } from "../../services/media-reliability";
import type { Env } from "../../types";

const testEnv = env as unknown as Env;

describe("RelayAPI Worker wiring in workerd", () => {
	it("serves the real health and OpenAPI handlers", async () => {
		const health = await worker.fetch(
			new Request("https://worker.test/health"),
			testEnv,
			createExecutionContext(),
		);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ status: "ok" });

		const contract = await worker.fetch(
			new Request("https://worker.test/openapi.json"),
			testEnv,
			createExecutionContext(),
		);
		expect(contract.status).toBe(200);
		const document = (await contract.json()) as {
			openapi?: string;
			paths?: Record<string, unknown>;
		};
		expect(document.openapi).toMatch(/^3\./);
		expect(document.paths?.["/v1/posts"]).toBeTruthy();
	});

	it("dispatches scheduled events through the real no-op cron branch", async () => {
		const context = createExecutionContext();
		await worker.scheduled?.(
			createScheduledController({ cron: "workerd-release-gate-noop" }),
			testEnv,
			context,
		);
	});

	it("constructs idempotent null-body replays with workerd Fetch semantics", () => {
		for (const status of [204, 205, 304]) {
			const response = new Response(replayBodyForStatus(status, ""), {
				status,
			});
			expect(response.status).toBe(status);
			expect(response.body).toBeNull();
		}
	});

	it("ACKs the real rescue consumer only after persisting its R2 ledger", async () => {
		const batch = createMessageBatch("relayapi-queue-rescue", [
			{
				id: "rescue-message",
				timestamp: new Date(0),
				attempts: 4,
				body: {
					version: 2 as const,
					originQueue: "relayapi-publish-dlq",
					originMessageId: "publish-message",
					originAttempts: 3,
					rescuedAt: "2026-07-13T00:00:00.000Z",
					organizationIds: ["org_workerd"],
					body: { organization_id: "org_workerd", post_id: "post_workerd" },
				},
			},
		]);
		const context = createExecutionContext();
		await worker.queue?.(batch, testEnv);
		const result = await getQueueResult(batch, context);

		expect(result.explicitAcks).toEqual(["rescue-message"]);
		expect(result.retryMessages).toEqual([]);
		const object = await testEnv.QUEUE_RESCUE_BUCKET.get(
			"queue-rescue/by-organization/org_workerd/relayapi-publish-dlq/publish-message.json",
		);
		expect(object).not.toBeNull();
		expect(await object?.json()).toMatchObject({
			originQueue: "relayapi-publish-dlq",
			originMessageId: "publish-message",
		});
	});

	it("retries instead of ACKing when the terminal R2 rescue write fails", async () => {
		const batch = createMessageBatch("relayapi-queue-rescue", [
			{
				id: "rescue-write-failure",
				timestamp: new Date(0),
				attempts: 4,
				body: {
					version: 2 as const,
					originQueue: "relayapi-email-dlq",
					originMessageId: "email-message",
					originAttempts: 3,
					rescuedAt: "2026-07-13T00:00:00.000Z",
					organizationIds: ["org_workerd"],
					body: { organization_id: "org_workerd", delivery_id: "email_1" },
				},
			},
		]);
		const context = createExecutionContext();
		await consumeQueueRescue(batch, {
			...testEnv,
			QUEUE_RESCUE_BUCKET: {
				put: async () => {
					throw new Error("simulated R2 outage");
				},
			} as unknown as R2Bucket,
		});
		const result = await getQueueResult(batch, context);

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toEqual([{ msgId: "rescue-write-failure" }]);
	});

	it("accepts only expected-source R2 create/delete notifications", () => {
		const base = {
			account: testEnv.R2_EVENT_ACCOUNT_ID,
			bucket: testEnv.R2_MEDIA_BUCKET_NAME,
			object: { key: "org_1/media_1.jpg" },
		};
		const expected = {
			account: testEnv.R2_EVENT_ACCOUNT_ID,
			bucket: testEnv.R2_MEDIA_BUCKET_NAME,
		};

		expect(
			isMediaEventMessage({ ...base, action: "PutObject" }, expected),
		).toBe(true);
		expect(
			isMediaEventMessage(
				{ ...base, action: "CompleteMultipartUpload" },
				expected,
			),
		).toBe(true);
		expect(
			isMediaEventMessage(
				{ ...base, account: "attacker-account", action: "PutObject" },
				expected,
			),
		).toBe(false);
		expect(
			isMediaEventMessage(
				{ ...base, bucket: "foreign-bucket", action: "DeleteObject" },
				expected,
			),
		).toBe(false);
		expect(
			isMediaEventMessage({ ...base, action: "UnknownAction" }, expected),
		).toBe(false);
	});

	it("upgrades and exchanges ping/pong through the real RealtimeDO", async () => {
		const namespace = testEnv.REALTIME as DurableObjectNamespace<
			InstanceType<typeof RealtimeDO>
		>;
		const stub = namespace.get(namespace.idFromName("workerd-release-gate"));
		const response = await stub.fetch("https://worker.test/socket", {
			headers: { Upgrade: "websocket" },
		});
		const socket = response.webSocket;
		expect(response.status).toBe(101);
		expect(socket).toBeTruthy();
		if (!socket) throw new Error("workerd did not return a WebSocket");

		socket.accept();
		const received = new Promise<string>((resolve) => {
			socket.addEventListener(
				"message",
				(event) => resolve(String(event.data)),
				{ once: true },
			);
		});
		socket.send(JSON.stringify({ type: "ping" }));
		expect(JSON.parse(await received)).toEqual({ type: "pong" });
		socket.close(1000, "test complete");
	});
});
