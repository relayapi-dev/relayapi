import { describe, expect, it } from "bun:test";
import {
	compareTimestampIdDescending,
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	InvalidPaginationCursorError,
	isLegacyIsoCursor,
	isTimestampIdAfterCursor,
	normalizeCursorTimestamp,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";

describe("versioned timestamp/id pagination cursors", () => {
	it("round-trips the complete composite sort key", () => {
		const timestamp = "2026-07-13T12:34:56.789123Z";
		const cursor = encodeTimestampIdCursor(timestamp, "post_abc");

		expect(cursor).not.toContain(timestamp);
		expect(decodeTimestampIdCursor(cursor)).toEqual({
			timestamp,
			id: "post_abc",
		});
	});

	it("preserves PostgreSQL's exact timestamp text without Date truncation", () => {
		const timestamp = "2026-07-13 12:34:56.789123+00";
		const cursor = encodeTimestampIdCursor(timestamp, "idea_abc");
		expect(decodeTimestampIdCursor(cursor).timestamp).toBe(timestamp);
	});

	it.each([
		"not-a-cursor",
		btoa(
			JSON.stringify({
				version: 2,
				timestamp: "2026-07-13T12:34:56.789Z",
				id: "x",
			}),
		),
		btoa(JSON.stringify({ version: 1, timestamp: "nope", id: "x" })),
		btoa(
			JSON.stringify({
				version: 1,
				timestamp: "2026-07-13T12:34:56.789Z",
				id: "",
			}),
		),
	])("rejects malformed or unsupported cursors: %s", (cursor) => {
		expect(() => decodeTimestampIdCursor(cursor)).toThrow(
			InvalidPaginationCursorError,
		);
	});

	it("orders equal timestamps by id without dropping tied rows", () => {
		const rows = ["row_a", "row_c", "row_b"].map((id) => ({
			timestamp: "2026-07-13T12:34:56.789123Z",
			id,
		}));
		rows.sort(compareTimestampIdDescending);

		expect(rows.map((row) => row.id)).toEqual(["row_c", "row_b", "row_a"]);
		const cursor = decodeTimestampIdCursor(
			encodeTimestampIdCursor(rows[1]?.timestamp ?? "", rows[1]?.id ?? ""),
		);
		const last = rows[2];
		if (!last) throw new Error("expected a third cursor row");
		expect(rows.filter((row) => isTimestampIdAfterCursor(row, cursor))).toEqual(
			[last],
		);
	});

	it("preserves microsecond ordering beyond JavaScript Date precision", () => {
		const newer = {
			timestamp: "2026-07-13T12:34:56.789456Z",
			id: "same_id",
		};
		const older = {
			timestamp: "2026-07-13T12:34:56.789123Z",
			id: "same_id",
		};

		expect(compareTimestampIdDescending(newer, older)).toBe(-1);
		expect(isTimestampIdAfterCursor(older, newer)).toBe(true);
	});
});

describe("cursor helper guards", () => {
	const acceptedTimestamps = [
		"2026-07-13T12:00:00Z",
		"2026-07-13T12:00:00.123Z",
		"2026-07-13T12:00:00.123456Z",
		"2026-07-13T12:00:00+0000",
		"2026-07-13T12:00:00+00:00",
		"2026-07-13 12:00:00.123456+00",
	];
	const rejectedTimestamps = [
		undefined,
		null,
		"",
		"   ",
		"not a date",
		"2026-07-13",
		"2026-13-01T00:00:00Z",
		// Nanosecond precision, e.g. Google Business createTime.
		"2026-07-13T12:00:00.1234567Z",
		1_752_403_200_000,
	];

	it("accepts every timestamp shape the providers and Postgres emit", () => {
		for (const value of acceptedTimestamps) {
			expect(normalizeCursorTimestamp(value)).toBe(value);
		}
	});

	it("rejects timestamps that cannot be ordered or encoded", () => {
		for (const value of rejectedTimestamps) {
			expect(normalizeCursorTimestamp(value)).toBeNull();
		}
	});

	it("guarantees a normalized timestamp can be both sorted and encoded", () => {
		// This is the property the inbox ingestion filter relies on: anything that
		// survives normalization can never throw later at a page boundary.
		for (const value of [...acceptedTimestamps, ...rejectedTimestamps]) {
			const normalized = normalizeCursorTimestamp(value);
			if (normalized === null) {
				expect(() => encodeTimestampIdCursor(value as string, "id_1")).toThrow(
					InvalidPaginationCursorError,
				);
				continue;
			}
			expect(() => encodeTimestampIdCursor(normalized, "id_1")).not.toThrow();
			expect(() =>
				compareTimestampIdDescending(
					{ timestamp: normalized, id: "a" },
					{ timestamp: normalized, id: "b" },
				),
			).not.toThrow();
		}
	});

	it("returns null instead of throwing for an undecodable cursor", () => {
		for (const cursor of [
			"",
			"not-a-cursor",
			"x".repeat(3000),
			btoa(JSON.stringify({ version: 2, timestamp: "2026-07-13T12:00:00Z", id: "a" }))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, ""),
			"med_0123456789abcdef",
		]) {
			expect(tryDecodeTimestampIdCursor(cursor)).toBeNull();
		}

		const valid = encodeTimestampIdCursor("2026-07-13T12:00:00Z", "med_1");
		expect(tryDecodeTimestampIdCursor(valid)).toEqual({
			timestamp: "2026-07-13T12:00:00Z",
			id: "med_1",
		});
	});

	it("never confuses a v1 cursor with a legacy raw-ISO cursor", () => {
		expect(isLegacyIsoCursor("2026-06-01T12:00:00.000Z")).toBe(true);
		expect(isLegacyIsoCursor("not-a-cursor")).toBe(false);
		expect(isLegacyIsoCursor("med_0123456789abcdef")).toBe(false);
		for (const value of acceptedTimestamps) {
			// ':' is absent from the base64url alphabet, so the two spaces are
			// provably disjoint and the legacy shim can never shadow a v1 cursor.
			expect(isLegacyIsoCursor(encodeTimestampIdCursor(value, "id_1"))).toBe(
				false,
			);
		}
	});
});
