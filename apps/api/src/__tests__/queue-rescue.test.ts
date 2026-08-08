import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	nominalQueueDeliveryBound,
	QUEUE_RESCUE_POLICY,
} from "../lib/async-policy";
import {
	consumeQueueRescue,
	createQueueRescueEnvelope,
	decryptQueueRescueBody,
	deleteQueueRescueSubjectPage,
	deleteQueueRescueSubjects,
	inferAutomaticRescueOriginQueue,
	persistQueueRescue,
} from "../queues/queue-rescue";
import type { Env } from "../types";

const TEST_ENCRYPTION_KEY = `test=${"a".repeat(64)}`;

function queueMessage(body: unknown, attempts = 1) {
	let acknowledgements = 0;
	const retries: number[] = [];
	const message: Message<unknown> = {
		id: "msg_test",
		timestamp: new Date("2026-07-13T12:00:00.000Z"),
		body,
		attempts,
		ack: () => {
			acknowledgements += 1;
		},
		retry: (options) => {
			retries.push(options?.delaySeconds ?? 0);
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
		options?: R2PutOptions,
	) => Promise<unknown>,
): Env {
	return {
		QUEUE_RESCUE_BUCKET: { put } as R2Bucket,
		ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
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
		const envelope = await createQueueRescueEnvelope(
			env,
			"relayapi-publish-dlq",
			message,
		);

		await persistQueueRescue(env, envelope);
		await persistQueueRescue(env, envelope);

		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).toContain(
			"by-organization/org_test/relayapi-publish-dlq/msg_test.json",
		);
	});

	it("redacts bodies that cannot be assigned to exactly one tenant", async () => {
		const env = envWithRescuePut(async () => null);
		const { message } = queueMessage({
			organization_ids: ["org_a", "org_b"],
			post_id: "post_1",
			private_body: "not safe to retain in an unscoped object",
		});

		const envelope = await createQueueRescueEnvelope(
			env,
			"relayapi-publish-dlq",
			message,
		);

		expect(envelope.organizationIds).toEqual([]);
		expect(await decryptQueueRescueBody(env, envelope)).toEqual({
			redacted: true,
			reason: "multiple_tenant_scope",
			operation_id: "post_1",
		});
	});

	it("derives media-event tenant scope from the object key", async () => {
		const env = envWithRescuePut(async () => null);
		const body = {
			account: "cf-account",
			bucket: "relayapi-media",
			action: "PutObject",
			object: { key: "org_media/uploads/photo.jpg" },
		};
		const { message } = queueMessage(body);

		const envelope = await createQueueRescueEnvelope(
			env,
			"relayapi-selfhost-media-cleanup-dlq",
			message,
		);

		expect(envelope.organizationIds).toEqual(["org_media"]);
		expect(await decryptQueueRescueBody(env, envelope)).toEqual(body);
	});

	it("derives self-host refresh operation identity from the account", async () => {
		const env = envWithRescuePut(async () => null);
		const { message } = queueMessage({
			organization_id: "org_refresh",
			account_id: "acc_refresh",
		});

		const envelope = await createQueueRescueEnvelope(
			env,
			"relayapi-selfhost-refresh-dlq",
			message,
		);

		expect(envelope.operationId).toBe("acc_refresh");
		expect(envelope.organizationIds).toEqual(["org_refresh"]);
	});

	it("stores only an application-encrypted body with stable AAD and typed locators", async () => {
		let stored = "";
		let metadata: Record<string, string> | undefined;
		const env = envWithRescuePut(async (_key, value, options) => {
			stored = String(value);
			metadata = options?.customMetadata;
			return null;
		});
		const secret = "recipient@example.com";
		const { message } = queueMessage({
			organization_id: "org_test",
			workspace_id: "ws_test",
			user_id: "user_test",
			contact_id: "contact_test",
			social_account_id: "acc_test",
			private_body: secret,
		});
		const envelope = await createQueueRescueEnvelope(
			env,
			"relayapi-email-dlq",
			message,
		);

		await persistQueueRescue(env, envelope);

		expect(stored).not.toContain(secret);
		expect(stored).not.toContain('"body":');
		expect(JSON.parse(stored)).toMatchObject({
			version: 3,
			bodyKeyId: "test",
		});
		expect(envelope.subjectLocators).toEqual([
			{ kind: "workspace", id: "ws_test" },
			{ kind: "user", id: "user_test" },
			{ kind: "contact", id: "contact_test" },
			{ kind: "account", id: "acc_test" },
		]);
		expect(JSON.parse(metadata?.subjectLocators ?? "[]")).toEqual(
			envelope.subjectLocators,
		);
		expect(await decryptQueueRescueBody(env, envelope)).toMatchObject({
			private_body: secret,
		});

		await expect(
			decryptQueueRescueBody(env, {
				...envelope,
				originMessageId: "different-message",
			}),
		).rejects.toThrow();
	});

	it("deletes one cursor-bounded subject page under the tenant prefix", async () => {
		const deleted: string[][] = [];
		const bucket = {
			list: async (options: R2ListOptions) => {
				expect(options.prefix).toBe("queue-rescue/by-organization/org_test/");
				expect(options.limit).toBe(2);
				expect(options.include).toContain("customMetadata");
				return {
					objects: [
						{
							key: "queue-rescue/by-organization/org_test/a.json",
							customMetadata: {
								subjectLocators: JSON.stringify([
									{ kind: "contact", id: "contact_delete" },
								]),
							},
						},
						{
							key: "queue-rescue/by-organization/org_test/b.json",
							customMetadata: {
								subjectLocators: JSON.stringify([
									{ kind: "contact", id: "contact_keep" },
								]),
							},
						},
					],
					truncated: true,
					cursor: "opaque-next",
				};
			},
			delete: async (keys: string[]) => {
				deleted.push(keys);
			},
		} as unknown as R2Bucket;

		const result = await deleteQueueRescueSubjectPage(
			bucket,
			"org_test",
			{ kind: "contact", id: "contact_delete" },
			{ limit: 2 },
		);

		expect(deleted).toEqual([["queue-rescue/by-organization/org_test/a.json"]]);
		expect(result).toEqual({
			deleted: 1,
			complete: false,
			cursor: "opaque-next",
		});
	});

	it("deletes several typed subjects with one bounded tenant scan", async () => {
		const cursors: Array<string | undefined> = [];
		const deleted: string[][] = [];
		const bucket = {
			list: async (options: R2ListOptions) => {
				cursors.push(options.cursor);
				return options.cursor
					? {
							objects: [
								{
									key: "queue-rescue/by-organization/org_test/b.json",
									customMetadata: {
										subjectLocators: JSON.stringify([
											{ kind: "contact", id: "contact_b" },
										]),
									},
								},
							],
							truncated: false,
						}
					: {
							objects: [
								{
									key: "queue-rescue/by-organization/org_test/a.json",
									customMetadata: {
										subjectLocators: JSON.stringify([
											{ kind: "contact", id: "contact_a" },
										]),
									},
								},
								{
									key: "queue-rescue/by-organization/org_test/keep.json",
									customMetadata: {
										subjectLocators: JSON.stringify([
											{ kind: "user", id: "user_keep" },
										]),
									},
								},
							],
							truncated: true,
							cursor: "page-two",
						};
			},
			delete: async (keys: string[]) => {
				deleted.push(keys);
			},
		} as unknown as R2Bucket;

		expect(
			await deleteQueueRescueSubjects(
				bucket,
				"org_test",
				[
					{ kind: "contact", id: "contact_a" },
					{ kind: "contact", id: "contact_b" },
				],
				{ pageSize: 2 },
			),
		).toBe(2);
		expect(cursors).toEqual([undefined, "page-two"]);
		expect(deleted).toEqual([
			["queue-rescue/by-organization/org_test/a.json"],
			["queue-rescue/by-organization/org_test/b.json"],
		]);
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
		expect(tracked.retries()).toHaveLength(0);
	});

	it("retries instead of acknowledging when R2 is unavailable", async () => {
		const env = envWithRescuePut(async () => {
			throw new Error("R2 unavailable");
		});
		const tracked = queueMessage({ broken: true }, 3);

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(tracked.acknowledgements()).toBe(0);
		expect(tracked.retries()).toHaveLength(1);
		expect(tracked.retries()[0]).toBeGreaterThanOrEqual(1);
		expect(tracked.retries()[0]).toBeLessThanOrEqual(
			QUEUE_RESCUE_POLICY.retry.capSeconds,
		);
	});

	it("ACKs and alerts at the terminal application attempt without self-handoff", async () => {
		const tracked = queueMessage(
			{ organization_id: "org_test", post_id: "post_1" },
			QUEUE_RESCUE_POLICY.terminalAttempt,
		);
		const env = {
			ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
			QUEUE_RESCUE_BUCKET: {
				put: async () => {
					throw new Error("R2 unavailable");
				},
			},
			QUEUE_RESCUE_QUEUE: {
				send: async () => {
					throw new Error("self-handoff must not be called");
				},
			},
		} as unknown as Env;

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(tracked.acknowledgements()).toBe(1);
		expect(tracked.retries()).toHaveLength(0);
	});

	it("preserves the actual rescue queue identity for an unenveloped platform transfer", async () => {
		const keys: string[] = [];
		const env = envWithRescuePut(async (key) => {
			keys.push(key);
			return null;
		});
		const tracked = queueMessage({ organization_id: "org_test" });

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(keys[0]).toContain("/relayapi-queue-rescue/");
		expect(keys[0]).not.toContain("unknown-dlq");
	});

	it("recovers every business DLQ identity from its consumer discriminant", () => {
		const hosted = {} as Pick<Env, "DEPLOYMENT_MODE">;
		const cases: Array<[unknown, string]> = [
			[
				{
					account: "cf-account",
					bucket: "relayapi-media",
					action: "PutObject",
					object: { key: "org_1/media/file_1/a.jpg" },
				},
				"media-cleanup",
			],
			[{ type: "publish_outbox", outbox_id: "out_1" }, "publish"],
			[{ id: "eml_1" }, "email"],
			[{ type: "refresh_token", account_id: "acc_1" }, "refresh"],
			[{ type: "raw_platform_webhook", receipt_id: "iwe_1" }, "inbox"],
			[{ type: "tool_job", job_id: "job_1" }, "tools"],
			[{ type: "sync_external", ad_account_id: "ada_1" }, "ads"],
			[{ type: "sync_posts", social_account_id: "acc_1" }, "sync"],
			[
				{ type: "deliver_customer_webhook", delivery_id: "whd_1" },
				"customer-webhooks",
			],
		];
		for (const [body, queueClass] of cases) {
			expect(inferAutomaticRescueOriginQueue(hosted, body)).toBe(
				`relayapi-${queueClass}-dlq`,
			);
		}
		expect(
			inferAutomaticRescueOriginQueue(
				{ DEPLOYMENT_MODE: "self_hosted" },
				{ type: "sync_posts" },
			),
		).toBe("relayapi-selfhost-sync-dlq");
		expect(
			inferAutomaticRescueOriginQueue(hosted, { unknown: true }),
		).toBeNull();
	});

	it("uses the recovered DLQ for raw automatic rescue transfers", async () => {
		const keys: string[] = [];
		const env = envWithRescuePut(async (key) => {
			keys.push(key);
			return null;
		});
		const tracked = queueMessage({
			type: "publish_outbox",
			outbox_id: "pob_1",
			org_id: "org_test",
		});

		await consumeQueueRescue(queueBatch(tracked.message), env);

		expect(keys[0]).toContain("/relayapi-publish-dlq/");
	});

	it("has a concrete finite cross-queue delivery bound", () => {
		expect(nominalQueueDeliveryBound(3)).toBe(48);
		expect(nominalQueueDeliveryBound(5)).toBe(50);
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

	it("classifies replay failures at the actual external boundary", () => {
		const source = readFileSync(
			new URL("../services/queue-replay.ts", import.meta.url),
			"utf8",
		);
		const claim = source.indexOf('status: "replay_claimed"');
		const customerHandoff = source.indexOf(
			"Customer webhook replay is a durable DB-outbox handoff",
			claim,
		);
		const customerTransaction = source.indexOf(
			"db.transaction(async (tx)",
			customerHandoff,
		);
		const customerResolved = source.indexOf(
			'status: "replayed"',
			customerTransaction,
		);
		const genericStart = source.indexOf(
			"let queueSendMayHaveOccurred = false",
			customerResolved,
		);
		const send = source.indexOf("await queue.send(replayPayload)");
		const safeCatch = source.indexOf("if (!queueSendMayHaveOccurred)", send);
		const safeRelease = source.indexOf('status: "unresolved"', safeCatch);
		const ambiguous = source.indexOf('status: "replay_unknown"', safeRelease);
		expect(claim).toBeGreaterThan(-1);
		expect(customerHandoff).toBeGreaterThan(claim);
		expect(customerTransaction).toBeGreaterThan(customerHandoff);
		expect(customerResolved).toBeGreaterThan(customerTransaction);
		expect(genericStart).toBeGreaterThan(customerResolved);
		expect(send).toBeGreaterThan(genericStart);
		expect(source).toContain(
			"queueSendMayHaveOccurred = true;\n\t\tawait queue.send(replayPayload)",
		);
		expect(safeCatch).toBeGreaterThan(send);
		expect(safeRelease).toBeGreaterThan(safeCatch);
		expect(ambiguous).toBeGreaterThan(safeRelease);
		const rawReceiptReset = source.slice(
			source.indexOf("if (rawReceiptId) {", genericStart),
			send,
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
		const customerWebhookReset = source.slice(customerHandoff, genericStart);
		expect(customerWebhookReset).toContain("db.transaction(async (tx)");
		expect(customerWebhookReset).toContain('status: "replayed"');
		expect(customerWebhookReset).toContain(
			"isNull(webhookDeliveries.operatorIntervenedAt)",
		);
		expect(customerWebhookReset).toContain(
			"isNull(webhookDeliveries.operatorRetryRequestedAt)",
		);
		expect(customerWebhookReset).toContain("repairAttempts: 0");
		expect(customerWebhookReset).toContain("repairDeadlineAt");
		expect(customerWebhookReset).toContain(
			"leaseToken: sql`$" + "{webhookDeliveries.leaseToken} + 1`",
		);
		expect(source).toContain(
			"Customer webhook failure payload has no delivery identity",
		);

		const crashReconciler = source.slice(
			source.indexOf("export async function reconcileQueueReplayClaims"),
		);
		expect(crashReconciler).toContain("durableWebhookIds");
		expect(crashReconciler).toContain("queueSendIds");
		expect(crashReconciler).toContain('status: "unresolved"');
		expect(crashReconciler).toContain('status: "replay_unknown"');
	});

	it("fences duplicate email workers with the durable claim timestamp", () => {
		const source = readFileSync(
			new URL("../queues/email.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("EMAIL_CLAIM_MS");
		expect(source).toContain(
			"eq(emailDeliveries.requestMayHaveBeenSentAt, requestBoundary)",
		);
		expect(source).toContain(
			"eq(emailDeliveries.leaseToken, claim.leaseToken)",
		);
		expect(source).toContain('claim.state === "busy"');
		expect(source).toContain("requestMayHaveBeenSentAt: null");
	});
});
