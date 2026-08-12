import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";

let syncError: unknown;
let recordedKind: string | null = null;
const syncCalls: Array<Record<string, unknown>> = [];

mock.module("../services/ad-analytics", () => ({
	fetchAndStoreAdMetrics: async () => {},
}));
mock.module("../services/ad-sync", () => ({
	syncAdMetrics: async (_env: unknown, input: Record<string, unknown>) => {
		syncCalls.push(input);
		if (syncError) throw syncError;
	},
	syncExternalAds: async (
		_env: unknown,
		accountId: string,
		organizationId: string,
	) => {
		syncCalls.push({ accountId, organizationId });
		if (syncError) throw syncError;
	},
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure: async (
		_env: unknown,
		_queue: string,
		_message: unknown,
		kind: string,
	) => {
		recordedKind = kind;
	},
}));

const { consumeAdsQueue } = await import("../queues/ads");

import type { Env } from "../types";

function trackedMessage(body: Record<string, unknown>, attempts = 1) {
	let acknowledgements = 0;
	let retries = 0;
	let retryDelay: number | undefined;
	const value = {
		id: "ads_operation_1",
		timestamp: new Date(),
		attempts,
		body,
		ack: () => {
			acknowledgements += 1;
		},
		retry: (options?: { delaySeconds?: number }) => {
			retries += 1;
			retryDelay = options?.delaySeconds;
		},
	} as Message<Record<string, unknown>>;
	return {
		value,
		acknowledgements: () => acknowledgements,
		retries: () => retries,
		retryDelay: () => retryDelay,
	};
}

function batch(message: Message<never>): MessageBatch<never> {
	return {
		messages: [message],
		queue: "relayapi-ads",
		metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
		ackAll: () => {},
		retryAll: () => {},
	};
}

describe("ads Queue identifier-only durability", () => {
	beforeEach(() => {
		syncError = undefined;
		recordedKind = null;
		syncCalls.length = 0;
	});

	it("rejects raw paid-operation parameters instead of carrying them in Queue", async () => {
		const message = trackedMessage({
			type: "create_ad",
			org_id: "org_1",
			params: { targeting: { emails: ["person@example.test"] } },
		});

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(recordedKind).toBe("permanent_input");
		expect(syncCalls).toEqual([]);
	});

	it("retries transient identifier-based metric sync", async () => {
		syncError = new Error("temporary database outage");
		const message = trackedMessage(
			{
				type: "sync_metrics",
				org_id: "org_1",
				ad_id: "ad_1",
			},
			2,
		);

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(0);
		expect(message.retries()).toBe(1);
		expect(message.retryDelay()).toBe(4);
		expect(recordedKind).toBeNull();
	});

	it("ACKs an identifier-based external sync", async () => {
		const message = trackedMessage({
			type: "sync_external",
			org_id: "org_1",
			ad_account_id: "ada_1",
		});

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(recordedKind).toBeNull();
		expect(syncCalls).toEqual([
			{ accountId: "ada_1", organizationId: "org_1" },
		]);
	});

	it("does not use inactive tenants or provider authorities for paid provider work", () => {
		const service = readFileSync(
			new URL("../services/ad-service.ts", import.meta.url),
			"utf8",
		);
		const reconciler = readFileSync(
			new URL("../services/ad-creation-operations.ts", import.meta.url),
			"utf8",
		);
		expect(service).toContain('eq(socialAccounts.lifecycleStatus, "active")');
		expect(service).toContain('eq(organization.lifecycleStatus, "active")');
		expect(reconciler).toContain(
			'"Paid operation cannot resume because its organization or provider authority is inactive"',
		);
		expect(reconciler).toContain('status: "manual_review"');
	});
});
