import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const postsSource = readFileSync(
	join(import.meta.dir, "../routes/posts.ts"),
	"utf8",
);

describe("bulk post usage settlement contract", () => {
	it("turns per-item workspace failures into outcome rows instead of a late 4xx", () => {
		expect(postsSource).not.toContain(
			"if (!itemScope.ok) return itemScope.response as never",
		);
		expect(postsSource).not.toContain(
			"if (!rowScope.ok) return rowScope.response as never",
		);
		expect(postsSource).toContain(
			"error: await bulkItemErrorFromResponse(itemScope.response)",
		);
		expect(postsSource).toContain(
			"error: await bulkItemErrorFromResponse(rowScope.response)",
		);
	});
});
