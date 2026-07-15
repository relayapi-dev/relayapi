/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import stripeWebhooks, {
	MAX_STRIPE_WEBHOOK_BYTES,
} from "../../routes/stripe-webhooks";
import type { Env } from "../../types";

describe("Stripe webhook body limits in workerd", () => {
	it("rejects an oversized streamed body without Content-Length", async () => {
		let chunk = 0;
		const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
			pull(controller) {
				chunk++;
				if (chunk === 1) {
					controller.enqueue(
						new Uint8Array(new ArrayBuffer(MAX_STRIPE_WEBHOOK_BYTES)),
					);
					return;
				}
				controller.enqueue(new Uint8Array(new ArrayBuffer(1)));
				controller.close();
			},
		});
		const request = new Request("https://worker.test/", {
			method: "POST",
			headers: { "stripe-signature": "test-signature" },
			body,
		});

		const response = await stripeWebhooks.fetch(request, {} as Env);

		expect(response.status).toBe(413);
		expect(await response.json<{ error: string }>()).toEqual({
			error: "Payload too large",
		});
	});
});
