import { describe, expect, it } from "bun:test";
import {
	compareTimestampIdDescending,
	encodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { hasSortableItemKey, hasSortablePostKey } from "../routes/inbox";

/**
 * The live comment/post feeds sort and encode cursors over provider payloads
 * that nothing validates — and over whatever was previously written to KV. The
 * keyset comparator and the cursor encoder both throw on a malformed sort key,
 * so before this screening one bad `created_at` from a single account produced
 * a 500 for the whole multi-account feed, and a poisoned cache entry kept doing
 * so for the rest of its TTL.
 */
describe("inbox provider timestamp screening", () => {
	const wellFormed = {
		id: "c_1",
		platform: "facebook",
		account_id: "acc_1",
		created_at: "2026-07-13T12:00:00+0000",
	};

	it("keeps the timestamp shapes each provider actually sends", () => {
		for (const created_at of [
			"2026-07-13T12:00:00+0000", // Facebook created_time
			"2026-07-13T12:00:00Z", // Instagram timestamp
			"2026-07-13T12:00:00.123456Z", // YouTube publishedAt
		]) {
			expect(hasSortableItemKey({ ...wellFormed, created_at })).toBe(true);
			expect(hasSortablePostKey({ ...wellFormed, created_at })).toBe(true);
		}
	});

	it("drops items whose sort key would throw downstream", () => {
		const poisoned: Array<Record<string, unknown>> = [
			{ ...wellFormed, created_at: undefined },
			{ ...wellFormed, created_at: null },
			{ ...wellFormed, created_at: "" },
			{ ...wellFormed, created_at: "not a date" },
			{ ...wellFormed, created_at: "2026-07-13" },
			// Nanosecond precision sorts fine but throws on encode, so it would
			// only have surfaced when the item landed on a page boundary.
			{ ...wellFormed, created_at: "2026-07-13T12:00:00.123456789Z" },
			{ ...wellFormed, id: "" },
			{ ...wellFormed, id: undefined },
			{ ...wellFormed, platform: undefined },
		];
		for (const item of poisoned) {
			expect(hasSortableItemKey(item)).toBe(false);
			expect(hasSortablePostKey(item)).toBe(false);
		}
	});

	it("requires account_id on posts but not on comments", () => {
		// Comments inherit account_id and post_id from the already-screened post
		// they were fetched for, so requiring it at the comment stage would drop
		// every comment.
		const comment = {
			id: "c_1",
			platform: "facebook",
			created_at: "2026-07-13T12:00:00Z",
		};
		expect(hasSortableItemKey(comment)).toBe(true);
		expect(hasSortablePostKey(comment)).toBe(false);
	});

	it("guarantees survivors can be sorted and encoded without throwing", () => {
		// This is the invariant the screening exists to establish.
		const mixed: Array<Record<string, unknown>> = [
			wellFormed,
			{ ...wellFormed, id: "c_2", created_at: "2026-07-13T12:00:00.999999Z" },
			{ ...wellFormed, id: "c_3", created_at: undefined },
			{ ...wellFormed, id: "c_4", created_at: "2026-07-13T12:00:00.1234567Z" },
		];
		const survivors = mixed.filter(hasSortablePostKey) as Array<{
			id: string;
			created_at: string;
		}>;

		expect(survivors.map((item) => item.id)).toEqual(["c_1", "c_2"]);
		expect(() =>
			survivors
				.slice()
				.sort((a, b) =>
					compareTimestampIdDescending(
						{ timestamp: a.created_at, id: a.id },
						{ timestamp: b.created_at, id: b.id },
					),
				),
		).not.toThrow();
		for (const item of survivors) {
			expect(() =>
				encodeTimestampIdCursor(item.created_at, item.id),
			).not.toThrow();
		}
	});
});
