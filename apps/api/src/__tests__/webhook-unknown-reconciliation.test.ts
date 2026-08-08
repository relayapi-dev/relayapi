import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

type Row = Record<string, unknown>;

let executeResults: Row[][] = [];
let insertedRows: Row[] = [];
let encryptedPayloadInputs: Row[] = [];

interface FakeDb {
	execute: () => Promise<Row[]>;
	transaction: <T>(run: (tx: FakeDb) => Promise<T>) => Promise<T>;
	insert: (_table: unknown) => {
		values: (rows: Row | Row[]) => {
			onConflictDoUpdate: (_config: unknown) => Promise<void>;
		};
	};
}

const fakeDb: FakeDb = {
	execute: async () => executeResults.shift() ?? [],
	transaction: async (run) => run(fakeDb),
	insert: () => ({
		values: (rows) => {
			insertedRows = Array.isArray(rows) ? rows : [rows];
			return { onConflictDoUpdate: async () => {} };
		},
	}),
};

const columns = (...names: string[]) =>
	Object.fromEntries(names.map((name) => [name, { name }]));

mock.module("@relayapi/db", () => ({
	SOCIAL_PLATFORM_IDS: ["twitter", "facebook"],
	createDb: () => fakeDb,
	inboxEventEffects: columns(
		"id",
		"status",
		"lastEnqueuedAt",
		"nextAttemptAt",
		"error",
		"updatedAt",
	),
	queueFailures: columns(
		"queueName",
		"messageId",
		"attempts",
		"error",
		"organizationId",
		"organizationIds",
	),
	webhookDeliveries: columns("id", "dispatchAttempts", "dispatchLeaseId"),
	webhookEndpoints: columns("id"),
	webhookEvents: columns("id"),
	webhookLogs: columns("id"),
}));
mock.module("../queues/failures", () => ({
	encryptQueueFailurePayload: async (
		_env: unknown,
		queueName: string,
		messageId: string,
		payload: unknown,
	) => {
		encryptedPayloadInputs.push({ queueName, messageId, payload });
		return {
			payloadCiphertext: "encrypted-test-payload",
			payloadKeyId: "test",
			payloadExpiresAt: new Date("2026-07-29T00:00:00.000Z"),
		};
	},
}));
mock.module("../services/operator-alerts", () => ({
	dispatchCustomerWebhookRepairExhaustedAlert: async () => {},
}));
mock.module("../services/inbox-event-processor", () => ({
	processInboxEvent: async () => {},
}));

const { reconcileCustomerWebhookDeliveries } = await import(
	"../services/webhook-delivery"
);
const { reconcileInboxEventEffects } = await import(
	"../services/inbox-effect-reconciler"
);

import type { Env } from "../types";

const errorSpy = spyOn(console, "error").mockImplementation(() => {});
const env = {
	HYPERDRIVE: { connectionString: "postgres://test" },
} as unknown as Env;

beforeEach(() => {
	executeResults = [];
	insertedRows = [];
	encryptedPayloadInputs = [];
});

afterAll(() => errorSpy.mockRestore());

describe("unknown-outcome reconciliation", () => {
	it("surfaces an ambiguous customer delivery in the scoped failure ledger", async () => {
		executeResults = [
			[{ status: "manual_review" }],
			[
				{
					id: "whd_1",
					organization_id: "org_1",
					attempts: 2,
					error: "request timed out",
				},
			],
			[],
		];

		const result = await reconcileCustomerWebhookDeliveries(env);

		expect(result).toEqual({
			recoveredPending: 0,
			markedUnknown: 1,
			unknownRecorded: 1,
			enqueued: 0,
		});
		expect(insertedRows).toEqual([
			expect.objectContaining({
				queueName: "relayapi-customer-webhooks",
				messageId: "delivery:whd_1",
				organizationIds: ["org_1"],
				operationId: "whd_1",
				failureKind: "unknown_external_outcome",
			}),
		]);
	});

	it("surfaces an ambiguous inbound effect with its replay input", async () => {
		executeResults = [
			[{ status: "unknown" }],
			[],
			[
				{
					id: "ief_1",
					organization_id: "org_1",
					effect: "realtime",
					attempts: 1,
					replay_payload: { type: "instagram_webhook", receipt_id: "iwe_1" },
					error: "effect lease expired after the side-effect boundary",
				},
			],
		];

		const result = await reconcileInboxEventEffects(env);

		expect(result).toEqual({
			recoveredPending: 0,
			markedUnknown: 1,
			unknownRecorded: 1,
			replayedMessages: 0,
		});
		expect(insertedRows).toEqual([
			expect.objectContaining({
				queueName: "relayapi-inbox",
				messageId: "effect:ief_1",
				organizationIds: ["org_1"],
				operationId: "ief_1",
				failureKind: "unknown_external_outcome",
				payloadCiphertext: "encrypted-test-payload",
			}),
		]);
		expect(encryptedPayloadInputs).toEqual([
			expect.objectContaining({
				queueName: "relayapi-inbox",
				messageId: "effect:ief_1",
				payload: expect.objectContaining({
					effect_id: "ief_1",
					effect: "realtime",
					replay_payload: {
						type: "instagram_webhook",
						receipt_id: "iwe_1",
					},
				}),
			}),
		]);
	});
});
