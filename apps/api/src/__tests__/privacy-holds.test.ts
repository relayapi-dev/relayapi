import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { roleIncludesOwner, visibleWorkspaceHoldIds } from "../routes/privacy";

describe("tenant-visible erasure holds", () => {
	it("requires an exact owner role and filters selected-scope principals", () => {
		expect(roleIncludesOwner("admin")).toBe(false);
		expect(roleIncludesOwner("admin, owner")).toBe(true);
		expect(roleIncludesOwner(null)).toBe(false);
		expect(visibleWorkspaceHoldIds(undefined, "all")).toBeNull();
		expect(visibleWorkspaceHoldIds(undefined, ["ws_1"])).toEqual(["ws_1"]);
		expect(visibleWorkspaceHoldIds("ws_2", ["ws_1", "ws_2"])).toEqual(["ws_2"]);
	});

	it("does not select operator-only authority, actors, or encrypted evidence", () => {
		const source = readFileSync(
			new URL("../routes/privacy.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toContain("erasureHolds.evidenceCiphertext");
		expect(source).not.toContain("erasureHolds.legalAuthorityRef");
		expect(source).not.toContain("erasureHolds.placedBy");
		expect(source).not.toContain("erasureHolds.releasedBy");
	});
});
