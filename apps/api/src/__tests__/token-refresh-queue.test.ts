import {
	afterAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";

class FakeTokenRefreshUnknownError extends Error {}
class FakeTokenRefreshAccountUnavailableError extends Error {}

let refreshError: unknown;
const refreshAccountToken = mock(async () => {
	if (refreshError) throw refreshError;
});

mock.module("../services/token-refresh-coordinator", () => ({
	refreshAccountToken,
	TokenRefreshAccountUnavailableError: FakeTokenRefreshAccountUnavailableError,
	TokenRefreshUnknownError: FakeTokenRefreshUnknownError,
}));
mock.module("../queues/failures", () => ({
	recordQueueFailure: async () => {},
}));

const { consumeTokenRefreshQueue } = await import("../queues/token-refresh");

import type { Env } from "../types";

const errorSpy = spyOn(console, "error").mockImplementation(() => {});

function trackedMessage() {
	let acknowledgements = 0;
	let retries = 0;
	let retryDelay: number | undefined;
	const value: Message<{
		type: string;
		account_id: string;
		organization_id: string;
	}> = {
		id: "msg_refresh",
		timestamp: new Date(),
		attempts: 2,
		body: {
			type: "refresh_token",
			account_id: "acc_test",
			organization_id: "org_test",
		},
		ack: () => {
			acknowledgements++;
		},
		retry: (options?: { delaySeconds?: number }) => {
			retries++;
			retryDelay = options?.delaySeconds;
		},
	};
	return {
		value,
		acknowledgements: () => acknowledgements,
		retries: () => retries,
		retryDelay: () => retryDelay,
	};
}

function batch(
	message: Message<{
		type: string;
		account_id: string;
		organization_id: string;
	}>,
): MessageBatch<{
	type: string;
	account_id: string;
	organization_id: string;
}> {
	return {
		messages: [message],
		queue: "relayapi-token-refresh",
		metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
		ackAll: () => {},
		retryAll: () => {},
	};
}

beforeEach(() => {
	refreshError = undefined;
	refreshAccountToken.mockClear();
});

afterAll(() => errorSpy.mockRestore());

describe("token refresh Queue outcomes", () => {
	it("rejects messages without a tenant scope", async () => {
		const message = trackedMessage();
		message.value.body.organization_id = "";

		await consumeTokenRefreshQueue(batch(message.value), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(refreshAccountToken).not.toHaveBeenCalled();
	});

	it("acknowledges a durable manual-review barrier without retrying", async () => {
		refreshError = new FakeTokenRefreshUnknownError("provider outcome unknown");
		const message = trackedMessage();

		await consumeTokenRefreshQueue(batch(message.value), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
		expect(refreshAccountToken).toHaveBeenCalledWith(
			{},
			"acc_test",
			"org_test",
		);
	});

	it("acknowledges an inactive or deleted account without retry noise", async () => {
		refreshError = new FakeTokenRefreshAccountUnavailableError(
			"account is inactive",
		);
		const message = trackedMessage();

		await consumeTokenRefreshQueue(batch(message.value), {} as Env);

		expect(message.acknowledgements()).toBe(1);
		expect(message.retries()).toBe(0);
	});

	it("still retries failures that did not become an unknown provider outcome", async () => {
		refreshError = new Error("temporary database outage");
		const message = trackedMessage();

		await consumeTokenRefreshQueue(batch(message.value), {} as Env);

		expect(message.acknowledgements()).toBe(0);
		expect(message.retries()).toBe(1);
		expect(message.retryDelay()).toBe(60);
	});

	it("keeps post-success audit logging inside a best-effort boundary", async () => {
		const source = await Bun.file(
			new URL("../services/token-refresh-coordinator.ts", import.meta.url),
		).text();
		const loggingCall = source.indexOf("await logConnectionEvent(");
		const warning = source.indexOf(
			"[Token Refresh] Success event logging failed",
			loggingCall,
		);
		expect(loggingCall).toBeGreaterThan(-1);
		expect(warning).toBeGreaterThan(loggingCall);
		expect(source.slice(loggingCall, warning)).toContain("} catch (error) {");
	});
});
