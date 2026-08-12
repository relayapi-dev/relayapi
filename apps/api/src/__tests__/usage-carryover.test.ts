import { describe, expect, it } from "bun:test";
import { effectiveCarryoverAllowance } from "../services/usage-carryover";

describe("settlement-aware usage carryover", () => {
	it("holds a successor to the terminal predecessor K rather than reserved N", () => {
		expect(effectiveCarryoverAllowance(9_700, 0)).toBe(9_700);
		expect(effectiveCarryoverAllowance(9_700, 7)).toBe(9_693);
		expect(effectiveCarryoverAllowance(5, 8)).toBe(0);
		expect(effectiveCarryoverAllowance(null, 8)).toBeNull();
	});

	it("rejects arithmetic that cannot be represented exactly", () => {
		for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => effectiveCarryoverAllowance(100, invalid)).toThrow(
				"Predecessor committed usage must be a nonnegative safe integer",
			);
		}
		expect(() => effectiveCarryoverAllowance(-1, 0)).toThrow(
			"Base included usage must be a nonnegative safe integer",
		);
	});
});
