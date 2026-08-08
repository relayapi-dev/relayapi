import { describe, expect, it } from "bun:test";
import { sanitizeLogText, sanitizeLogValue } from "./safe-console";

describe("dashboard Workers Logs privacy boundary", () => {
	it("redacts secrets, URLs, and personal identifiers", () => {
		const output = sanitizeLogText(
			"person@example.com https://provider.example/u/1 authorization: Bearer-secret +1 415 555 0199",
		);

		expect(output).not.toContain("person@example.com");
		expect(output).not.toContain("provider.example");
		expect(output).not.toContain("Bearer-secret");
		expect(output).not.toContain("415");
	});

	it("reduces structured values to approved operational fields", () => {
		expect(
			sanitizeLogValue({
				event: "cleanup",
				deleted: 3,
				rawProviderBody: "personal data",
			}),
		).toEqual({ event: "cleanup", deleted: 3 });
	});
});
