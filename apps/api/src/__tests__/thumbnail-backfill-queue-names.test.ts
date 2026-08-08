import { describe, expect, it } from "bun:test";
import { MEDIA_DEAD_LETTER_QUEUE_NAMES } from "../services/thumbnail-backfill";

describe("thumbnail backfill Queue ledger selection", () => {
	it("selects hosted and self-hosted media DLQ records", () => {
		expect(MEDIA_DEAD_LETTER_QUEUE_NAMES).toEqual([
			"relayapi-selfhost-media-cleanup-dlq",
			"relayapi-media-cleanup-dlq",
		]);
	});
});
