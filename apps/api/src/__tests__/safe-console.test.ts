import { describe, expect, it } from "bun:test";
import { sanitizeLogText, sanitizeLogValue } from "../lib/safe-console";

describe("Workers Logs privacy boundary", () => {
	it("redacts personal identifiers, URLs, and credentials from text", () => {
		const output = sanitizeLogText(
			"email=person@example.com url=https://provider.example/profile/123 token=secret-value phone=+44 7700 900123",
		);

		expect(output).not.toContain("person@example.com");
		expect(output).not.toContain("provider.example");
		expect(output).not.toContain("secret-value");
		expect(output).not.toContain("7700");
		expect(output).toContain("[redacted-email]");
		expect(output).toContain("[redacted-url]");
		expect(output).toContain("token=[redacted]");
		expect(output).toContain("[redacted-number]");
	});

	it("keeps bounded operational fields while dropping arbitrary provider bodies", () => {
		expect(
			sanitizeLogValue({
				event: "retention_backlog",
				organizationId: "org_123",
				count: 12,
				providerResponse: {
					email: "person@example.com",
					access_token: "secret",
				},
			}),
		).toEqual({
			event: "retention_backlog",
			organizationId: "org_123",
			count: 12,
		});
	});

	it("never persists Error messages or stacks", () => {
		const error = new Error(
			"provider rejected person@example.com with token=secret",
		) as Error & { code: string };
		error.code = "UPSTREAM_REJECTED";

		expect(sanitizeLogValue(error)).toEqual({
			error_name: "Error",
			error_code: "UPSTREAM_REJECTED",
		});
	});
});
