import { describe, expect, it } from "bun:test";
import { mapAuthDatabaseError } from "./auth-database-error";

describe("auth database error mapping", () => {
	it("maps only the owner invariant to a sanitized conflict", async () => {
		const response = mapAuthDatabaseError({
			code: "23514",
			message: "an active organization must retain at least one owner",
		});

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error: {
				code: "SOLE_ORGANIZATION_OWNER",
				message:
					"Transfer ownership or delete the organization before removing its sole owner.",
			},
		});
		expect(
			mapAuthDatabaseError({
				code: "23514",
				message: "some unrelated check constraint",
			}),
		).toBeNull();
	});

	it("maps serialization failures to a retryable conflict", async () => {
		const response = mapAuthDatabaseError({
			cause: { code: "40001", message: "could not serialize access" },
		});

		expect(response?.status).toBe(409);
		expect(response?.headers.get("Retry-After")).toBe("1");
		expect(await response?.json()).toMatchObject({
			error: { code: "AUTH_WRITE_CONFLICT" },
		});
	});

	it("rejects late membership writes to a deleting organization cleanly", async () => {
		const response = mapAuthDatabaseError({
			code: "23514",
			message: "members may only be added to active organizations",
		});

		expect(response?.status).toBe(409);
		expect(await response?.json()).toEqual({
			error: {
				code: "ORGANIZATION_NOT_ACTIVE",
				message: "Members cannot be added while an organization is deleting.",
			},
		});
	});
});
