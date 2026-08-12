import { describe, expect, it } from "bun:test";

describe("billing outbox pagination", () => {
	it("does not spend the provider failure budget on successful cache pages", async () => {
		const source = await Bun.file(
			new URL("../services/billing-outbox.ts", import.meta.url),
		).text();
		const continuation = source.slice(
			source.indexOf("if (continuationPayload)"),
			source.indexOf("const completed = await db"),
		);
		expect(continuation).toContain('status: "pending"');
		expect(continuation).toContain("attempts: 0");
		expect(continuation).toContain("payload: continuationPayload");
	});
});
