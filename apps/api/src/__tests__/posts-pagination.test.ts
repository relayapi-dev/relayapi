import { describe, expect, it } from "bun:test";
import { mergeByPublishedAt } from "../routes/posts";

// ===========================================================================
// Posts list pagination — cursor regression
//
// Regression for the "Load more" bug: listPosts filtered by date
// (`lt(coalesce(published_at, created_at), new Date(cursor))`) but returned the
// last post's *id* as `next_cursor`. Sending an id back as the cursor produced
// `new Date("post_…")` → Invalid Date, so the second page never loaded.
//
// The cursor must be the sort key (`published_at ?? created_at`) of the last
// merged item, and that value must round-trip through `new Date()`.
// ===========================================================================

const internal = [
	{ id: "post_b", published_at: null, created_at: "2026-06-07T16:54:00.000Z" },
	{ id: "post_a", published_at: "2026-06-07T16:41:00.000Z", created_at: "2026-06-07T16:40:00.000Z" },
];
const external = [
	{ id: "ext_y", published_at: "2026-06-07T16:50:00.000Z", created_at: "2026-06-07T16:50:00.000Z" },
	{ id: "ext_x", published_at: "2026-06-06T09:00:00.000Z", created_at: "2026-06-06T09:00:00.000Z" },
];

const sortKey = (
	item: { published_at?: string | null; created_at?: string | null } | undefined,
) => new Date(item?.published_at ?? item?.created_at ?? 0).getTime();

describe("mergeByPublishedAt", () => {
	it("interleaves internal and external descending by published_at ?? created_at", () => {
		const merged = mergeByPublishedAt(internal, external, 10);
		expect(merged.map((m) => m.id)).toEqual(["post_b", "ext_y", "post_a", "ext_x"]);
		for (let i = 1; i < merged.length; i++) {
			expect(sortKey(merged[i - 1])).toBeGreaterThanOrEqual(sortKey(merged[i]));
		}
	});

	it("caps the merged page at the limit", () => {
		const merged = mergeByPublishedAt(internal, external, 2);
		expect(merged).toHaveLength(2);
		expect(merged.map((m) => m.id)).toEqual(["post_b", "ext_y"]);
	});

	it("derives a next_cursor that is a valid date, not an id", () => {
		const merged = mergeByPublishedAt(internal, external, 2);
		const last = merged.at(-1);
		if (!last) throw new Error("expected a merged row");
		const cursor = last.published_at ?? last.created_at;
		// The bug returned `last.id` (e.g. "ext_y") here, which is an Invalid Date.
		expect(Number.isNaN(new Date(cursor).getTime())).toBe(false);
		expect(cursor).toBe("2026-06-07T16:50:00.000Z");
		// Sanity: the old id-based cursor would NOT parse.
		expect(Number.isNaN(new Date(last.id).getTime())).toBe(true);
	});
});
