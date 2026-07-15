import { describe, expect, it } from "bun:test";

describe("publish outbox immediate handoff", () => {
	it("drains every producer batch that creates pending follow-up work", async () => {
		const sources = await Promise.all(
			[
				"../queues/publish.ts",
				"../services/rss-generator.ts",
				"../services/recycling-processor.ts",
				"../services/streak.ts",
				"../services/weekly-digest.ts",
			].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
		);

		for (const source of sources) {
			expect(source).toContain("dispatchPublishOutbox(env)");
		}
	});
});
