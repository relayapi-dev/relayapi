/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import platformWebhooks, {
	MAX_PLATFORM_WEBHOOK_BYTES,
} from "../../routes/platform-webhooks";
import type { Env } from "../../types";

describe("platform webhook body limits in workerd", () => {
	it("rejects an oversized streamed envelope without a Content-Length header", async () => {
		let chunk = 0;
		const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull(controller) {
				chunk++;
				if (chunk === 1) {
					controller.enqueue(
						new Uint8Array(new ArrayBuffer(MAX_PLATFORM_WEBHOOK_BYTES)),
					);
					return;
				}
				controller.enqueue(new Uint8Array(new ArrayBuffer(1)));
				controller.close();
			},
		});
		const request = new Request("https://worker.test/telegram/server-secret", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": "server-secret",
			},
			body,
		});

		const response = await platformWebhooks.fetch(request, {
			TELEGRAM_WEBHOOK_SECRET: "server-secret",
		} as Env);

		expect(response.status).toBe(413);
		expect(await response.json<{ error: string }>()).toEqual({
			error: "Payload too large",
		});
	});
});
