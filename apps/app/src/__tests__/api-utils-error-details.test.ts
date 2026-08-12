import { describe, expect, it, spyOn } from "bun:test";
import { handleSdkError } from "../lib/api-utils";

describe("handleSdkError", () => {
	it("preserves structured backend error details", async () => {
		const log = spyOn(console, "error").mockImplementation(() => {});
		const response = handleSdkError({
			status: 409,
			message: "Request failed",
			error: {
				error: {
					code: "WORKSPACE_SCOPE_BLOCKERS",
					message: "Resolve workspace blockers first.",
					details: {
						total: 2,
						blockers: [{ resource_type: "posts", count: 2 }],
					},
				},
			},
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: {
				code: "WORKSPACE_SCOPE_BLOCKERS",
				message: "Resolve workspace blockers first.",
				details: {
					total: 2,
					blockers: [{ resource_type: "posts", count: 2 }],
				},
			},
		});
		log.mockRestore();
	});

	it("does not expose unexpected internal error messages", async () => {
		const log = spyOn(console, "error").mockImplementation(() => {});
		// Preserve a credential-bearing runtime value without committing a
		// credential-shaped database URL as a contiguous source literal.
		const secret = [
			"postgres://private-user:",
			"synthetic-password",
			"@internal-db.invalid/relayapi",
		].join("");
		const response = handleSdkError(new Error(secret));

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: "PROXY_ERROR",
				message: "The API request could not be completed.",
			},
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
		log.mockRestore();
	});
});
