import { afterEach, describe, expect, it, mock } from "bun:test";
import { listNumberOrders } from "../services/telnyx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Telnyx pre-live account inventory", () => {
	it("enumerates number orders with explicit pagination", async () => {
		let requestedUrl = "";
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				requestedUrl = String(input);
				return Response.json({
					data: [
						{
							id: "order_1",
							status: "pending",
							customer_reference: "operation_1",
							phone_numbers: [{ phone_number: "+12025550123" }],
							updated_at: "2026-07-31T12:00:00Z",
						},
					],
					meta: {
						page_number: 1,
						page_size: 100,
						total_pages: 1,
						total_results: 1,
					},
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);

		expect(await listNumberOrders("telnyx-secret")).toEqual([
			{
				id: "order_1",
				status: "pending",
				customerReference: "operation_1",
				phoneNumbers: ["+12025550123"],
				updatedAt: "2026-07-31T12:00:00Z",
			},
		]);
		expect(requestedUrl).toContain("/v2/number_orders?");
		expect(requestedUrl).toContain("page%5Bnumber%5D=1");
		expect(requestedUrl).toContain("page%5Bsize%5D=100");
	});

	it("rejects a truncated number-order response without required page metadata", async () => {
		globalThis.fetch = Object.assign(
			mock(async () => Response.json({ data: [] })),
			{ preconnect: originalFetch.preconnect },
		);

		await expect(listNumberOrders("telnyx-secret")).rejects.toThrow(
			"pagination was invalid",
		);
	});

	it("accepts the provider's zero-page representation only for an empty first page", async () => {
		globalThis.fetch = Object.assign(
			mock(async () =>
				Response.json({
					data: [],
					meta: { page_number: 1, total_pages: 0 },
				}),
			),
			{ preconnect: originalFetch.preconnect },
		);

		expect(await listNumberOrders("telnyx-secret")).toEqual([]);
	});
});
