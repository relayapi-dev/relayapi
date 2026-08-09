import { describe, expect, it } from "bun:test";

const routeFiles = [
	"content-templates.ts",
	"connections.ts",
	"posts.ts",
	"threads.ts",
	"ideas.ts",
	"signatures.ts",
] as const;

describe("self-host stable pagination compatibility", () => {
	it("ships opaque composite cursors without adding infrastructure", async () => {
		const sources = await Promise.all(
			routeFiles.map((file) =>
				Bun.file(
					new URL(`../../../apps/api/src/routes/${file}`, import.meta.url),
				).text(),
			),
		);

		for (const source of sources) {
			// Any of the opaque decoders satisfies this: `decodeKeysetCursor` wraps
			// the strict decode with a one-release fallback for the raw-ISO cursors
			// these endpoints used to emit, so operators upgrading across the
			// change keep paginating instead of getting a 400 mid-walk.
			expect(source).toMatch(
				/\b(decodeTimestampIdCursor|tryDecodeTimestampIdCursor|decodeKeysetCursor)\b/,
			);
			expect(source).toContain("encodeTimestampIdCursor");
			// The legacy shim must go through the decoder, never re-introduce an
			// unguarded date parse of raw client input.
			expect(source).not.toContain("new Date(cursor)");
		}
	});

	it("keeps merged inbox cursors unique across provider namespaces", async () => {
		const source = await Bun.file(
			new URL("../../../apps/api/src/routes/inbox.ts", import.meta.url),
		).text();

		for (const identityPart of [
			"comment.platform",
			"comment.account_id",
			"comment.post_id",
			"comment.id",
		]) {
			expect(source).toContain(identityPart);
		}
		expect(source).toContain("isTimestampIdAfterCursor");
	});
});
