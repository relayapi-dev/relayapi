import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { secondsUntilNextUtcDay } from "../middleware/tool-rate-limit";

describe("rate-limit retry hints", () => {
	it("uses the exact remaining UTC-day window for daily tool quota", () => {
		expect(
			secondsUntilNextUtcDay(new Date("2026-07-31T23:59:59.250Z")),
		).toBe(1);
		expect(
			secondsUntilNextUtcDay(new Date("2026-07-31T12:00:00.000Z")),
		).toBe(43_200);
	});

	it("publishes conservative edge-limit and CORS retry headers", () => {
		const rateLimitSource = readFileSync(
			join(import.meta.dir, "../middleware/rate-limit.ts"),
			"utf8",
		);
		const appSource = readFileSync(join(import.meta.dir, "../app.ts"), "utf8");
		expect(rateLimitSource).toContain('c.header("Retry-After", "60")');
		expect(appSource).toContain('"Retry-After"');
	});
});
