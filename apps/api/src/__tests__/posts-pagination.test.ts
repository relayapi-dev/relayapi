import { describe, expect, it } from "bun:test";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { mergeByPublishedAt } from "../routes/posts";

// ===========================================================================
// Posts list pagination — cursor regression
//
// Regression for the "Load more" bug: listPosts filtered by date
// (`lt(coalesce(published_at, created_at), new Date(cursor))`) but returned the
// last post's *id* as `next_cursor`. Sending an id back as the cursor produced
// `new Date("post_…")` → Invalid Date, so the second page never loaded.
//
// The cursor must contain the complete composite sort key
// (`published_at ?? created_at`, id), not expose either value directly.
// ===========================================================================

const internal = [
	{ id: "post_b", published_at: null, created_at: "2026-06-07T16:54:00.000Z" },
	{
		id: "post_a",
		published_at: "2026-06-07T16:41:00.000Z",
		created_at: "2026-06-07T16:40:00.000Z",
	},
];
const external = [
	{
		id: "ext_y",
		published_at: "2026-06-07T16:50:00.000Z",
		created_at: "2026-06-07T16:50:00.000Z",
	},
	{
		id: "ext_x",
		published_at: "2026-06-06T09:00:00.000Z",
		created_at: "2026-06-06T09:00:00.000Z",
	},
];

const sortKey = (
	item:
		| { published_at?: string | null; created_at?: string | null }
		| undefined,
) => new Date(item?.published_at ?? item?.created_at ?? 0).getTime();

describe("mergeByPublishedAt", () => {
	it("interleaves internal and external descending by published_at ?? created_at", () => {
		const merged = mergeByPublishedAt(internal, external, 10);
		expect(merged.map((m) => m.id)).toEqual([
			"post_b",
			"ext_y",
			"post_a",
			"ext_x",
		]);
		for (let i = 1; i < merged.length; i++) {
			expect(sortKey(merged[i - 1])).toBeGreaterThanOrEqual(sortKey(merged[i]));
		}
	});

	it("caps the merged page at the limit", () => {
		const merged = mergeByPublishedAt(internal, external, 2);
		expect(merged).toHaveLength(2);
		expect(merged.map((m) => m.id)).toEqual(["post_b", "ext_y"]);
	});

	it("orders equal timestamps by id descending", () => {
		const timestamp = "2026-06-07T16:50:00.000Z";
		const merged = mergeByPublishedAt(
			[{ id: "post_a", published_at: timestamp }],
			[{ id: "ext_z", published_at: timestamp }],
			10,
		);
		expect(merged.map((item) => item.id)).toEqual(["post_a", "ext_z"]);
	});

	it("preserves sub-millisecond ordering when merging sources", () => {
		const merged = mergeByPublishedAt(
			[{ id: "post_z", published_at: "2026-06-07T16:50:00.123001Z" }],
			[{ id: "ext_a", published_at: "2026-06-07T16:50:00.123999Z" }],
			10,
		);
		expect(merged.map((item) => item.id)).toEqual(["ext_a", "post_z"]);
	});

	it("derives an opaque next_cursor with timestamp and id", () => {
		const merged = mergeByPublishedAt(internal, external, 2);
		const last = merged.at(-1);
		if (!last) throw new Error("expected a merged row");
		const timestamp = last.published_at ?? last.created_at;
		if (!timestamp) throw new Error("expected timestamp");
		const cursor = encodeTimestampIdCursor(timestamp, last.id);

		expect(cursor).not.toContain(timestamp);
		expect(decodeTimestampIdCursor(cursor)).toEqual({
			timestamp: "2026-06-07T16:50:00.000Z",
			id: "ext_y",
		});
	});
});
