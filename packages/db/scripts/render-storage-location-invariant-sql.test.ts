import { describe, expect, it } from "bun:test";
import { renderStorageLocationInvariantSql } from "./render-storage-location-invariant-sql";

describe("storage location invariant SQL", () => {
	it("keeps routing immutable and closes credential transitions", () => {
		const sql = renderStorageLocationInvariantSql();
		expect(sql).toContain(
			"storage location routing fields are immutable; insert a new location",
		);
		expect(sql).toContain(
			"storage credential identity is immutable; insert a new version",
		);
		expect(sql).toContain(
			"OLD.state = 'staged' AND NEW.state IN ('active', 'failed')",
		);
		expect(sql).toContain(
			"OLD.state = 'active' AND NEW.state = 'retired'",
		);
		expect(sql).not.toContain("OLD.state = 'retired' AND");
	});
});
