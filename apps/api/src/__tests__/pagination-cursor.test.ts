import { describe, expect, it } from "bun:test";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	InvalidPaginationCursorError,
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
});
