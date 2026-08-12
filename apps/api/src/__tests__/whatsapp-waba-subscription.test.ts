import { afterEach, describe, expect, test } from "bun:test";
import { subscribeWhatsAppBusinessAccount } from "../services/webhook-subscription";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("WhatsApp WABA subscription", () => {
	test("uses the official subscribed_apps endpoint with bearer auth", async () => {
		let request: Request | undefined;
		globalThis.fetch = (async (input, init) => {
			request = new Request(input, init);
			return Response.json({ success: true });
		}) as typeof fetch;

		expect(
			await subscribeWhatsAppBusinessAccount("123456", "system-token"),
		).toEqual({ success: true });
		expect(request?.method).toBe("POST");
		expect(request?.url).toContain("/123456/subscribed_apps");
		expect(request?.headers.get("authorization")).toBe("Bearer system-token");
	});

	test("does not claim success when Meta rejects the subscription", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: { message: "permission denied", code: 200 } },
				{ status: 403 },
			)) as unknown as typeof fetch;
		const result = await subscribeWhatsAppBusinessAccount("123456", "bad");
		expect(result.success).toBe(false);
		expect(result.error).toBe("permission denied");
	});
});
