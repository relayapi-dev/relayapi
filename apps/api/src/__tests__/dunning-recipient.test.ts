import { describe, expect, it } from "bun:test";
import { selectDunningBillingEmail } from "../services/dunning";

describe("dunning billing recipient", () => {
	it("selects an owner from a compound Better Auth role", () => {
		expect(
			selectDunningBillingEmail([
				{ email: "admin@example.com", role: "admin" },
				{ email: "owner@example.com", role: "admin, owner" },
			]),
		).toBe("owner@example.com");
	});

	it("does not accept non-owner role substrings", () => {
		expect(
			selectDunningBillingEmail([
				{ email: "admin@example.com", role: "admin" },
				{ email: "not-owner@example.com", role: "homeowner" },
			]),
		).toBeNull();
	});
});
