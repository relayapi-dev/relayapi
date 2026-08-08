import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { processInboxEvent } from "../services/inbox-event-processor";
import { subscribeYouTubeChannel } from "../services/webhook-subscription";
import type { Env } from "../types";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

function subscriptionMessage() {
	return {
		type: "youtube_subscribe" as const,
		platform: "youtube",
		platform_account_id: "UC123",
		organization_id: "org_123",
		account_id: "acc_123",
		event_type: "subscribe",
		received_at: new Date().toISOString(),
	};
}

describe("YouTube authenticated subscriptions", () => {
	beforeEach(() => {
		fetchMock = mock(async () => new Response(null, { status: 202 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("requires a hub secret before making the subscription request", async () => {
		const result = await subscribeYouTubeChannel(
			"UC123",
			"https://api.example.test/webhooks/platform/youtube",
			undefined as unknown as string,
		);

		expect(result.success).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends the same hub.secret used by inbound verification", async () => {
		const result = await subscribeYouTubeChannel(
			"UC123",
			"https://api.example.test/webhooks/platform/youtube",
			"shared-hub-secret",
		);

		expect(result.success).toBe(true);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		const params = new URLSearchParams(String((init as RequestInit).body));
		expect(params.get("hub.secret")).toBe("shared-hub-secret");
		expect(params.get("hub.mode")).toBe("subscribe");
		expect(params.get("hub.topic")).toBe(
			"https://www.youtube.com/feeds/videos.xml?channel_id=UC123",
		);
	});

	it("throws so the queue retries when initial subscription fails", async () => {
		fetchMock.mockImplementation(
			async () => new Response("hub unavailable", { status: 503 }),
		);

		expect(
			processInboxEvent(subscriptionMessage(), {
				YOUTUBE_HUB_SECRET: "shared-hub-secret",
				API_BASE_URL: "https://api.example.test",
			} as Env),
		).rejects.toThrow("YouTube subscribe failed");
	});

	it("throws before network I/O when initial subscription is unconfigured", async () => {
		expect(processInboxEvent(subscriptionMessage(), {} as Env)).rejects.toThrow(
			"YOUTUBE_HUB_SECRET is not configured",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
