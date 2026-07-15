import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { AdPlatformError } from "../services/ad-platforms/types";

let createError: unknown;
let recordedKind: string | null = null;

mock.module("../services/ad-analytics", () => ({
	fetchAndStoreAdMetrics: async () => {},
}));
mock.module("../services/ad-audience", () => ({
	addUsersToAudience: async () => {},
}));
mock.module("../services/ad-service", () => ({
	createAd: async () => {
		if (createError) throw createError;
	},
	boostPost: async () => {
		if (createError) throw createError;
	},
}));
mock.module("../services/ad-sync", () => ({
	syncExternalAds: async () => {},
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

function trackedMessage(type: "create_ad" | "boost_post", attempts = 1) {
	let acknowledgements = 0;
	let retries = 0;
	let retryDelay: number | undefined;
	const value = {
		id: "ads_operation_1",
		timestamp: new Date(),
		attempts,
		body: { type, org_id: "org_1", params: {} },
		ack: () => {
			acknowledgements += 1;
		},
		retry: (options?: { delaySeconds?: number }) => {
			retries += 1;
			retryDelay = options?.delaySeconds;
		},
	} as Message<{
		type: string;
		org_id: string;
		params: Record<string, unknown>;
	}>;
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

describe("ads Queue paid-operation durability", () => {
	beforeEach(() => {
		createError = undefined;
		recordedKind = null;
	});

	it("retries a pre-boundary/transient paid-operation failure", async () => {
		createError = new Error("temporary database outage");
		const message = trackedMessage("create_ad", 2);

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(0);
		expect(message.retries()).toBe(1);
		expect(message.retryDelay()).toBe(4);
		expect(recordedKind).toBeNull();
	});

	it("records and ACKs an already-ambiguous provider outcome", async () => {
		createError = new AdPlatformError(
			"UNKNOWN_EXTERNAL_OUTCOME",
			"provider may have accepted the request",
		);
		const message = trackedMessage("boost_post");

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(recordedKind).toBe("unknown_external_outcome");
	});

	it("records and ACKs permanent paid-operation input", async () => {
		createError = new AdPlatformError(
			"MISSING_OBJECTIVE",
			"objective is required",
		);
		const message = trackedMessage("create_ad");

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(recordedKind).toBe("permanent_input");
	});

	it("ACKs a completed paid operation", async () => {
		const message = trackedMessage("create_ad");

		await consumeAdsQueue(batch(message.value as Message<never>), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(recordedKind).toBeNull();
	});

	it("does not use inactive tenants or social accounts for paid provider work", () => {
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
			'"Paid operation cannot resume because its organization or social account is inactive"',
		);
		expect(reconciler).toContain('status: "manual_review"');
	});
});
