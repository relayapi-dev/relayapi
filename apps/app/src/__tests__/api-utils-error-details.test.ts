import { describe, expect, it } from "bun:test";
import { handleSdkError } from "../lib/api-utils";

describe("handleSdkError", () => {
	it("preserves structured backend error details", async () => {
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
	});
});
