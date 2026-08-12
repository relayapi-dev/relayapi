import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mediaDerivativeStorageKey } from "../lib/media-processing-key";
import { supportsMediaProcessingIntent } from "../services/media-processing-jobs";

describe("media processing generation fence", () => {
	test("uses a distinct immutable R2 key for each lease generation", () => {
		const base = {
			organizationId: "org_test",
			mediaId: "med_test",
			jobId: "mjob_test",
			kind: "normalized" as const,
			mimeType: "video/mp4",
		};
		const first = mediaDerivativeStorageKey({ ...base, generation: 1 });
		const recovered = mediaDerivativeStorageKey({ ...base, generation: 2 });

		expect(first).toContain("/generation-1/");
		expect(recovered).toContain("/generation-2/");
		expect(first).not.toBe(recovered);
	});

	test("rejects invalid generations and unsupported output formats", () => {
		expect(() =>
			mediaDerivativeStorageKey({
				organizationId: "org_test",
				mediaId: "med_test",
				jobId: "mjob_test",
				generation: 0,
				kind: "cover",
				mimeType: "image/jpeg",
			}),
		).toThrow("positive integer");
		expect(() =>
			mediaDerivativeStorageKey({
				organizationId: "org_test",
				mediaId: "med_test",
				jobId: "mjob_test",
				generation: 1,
				kind: "cover",
				mimeType: "application/pdf",
			}),
		).toThrow("Unsupported processor output MIME type");
	});

	test("rejects cover extraction for audio and document media before enqueue", () => {
		expect(supportsMediaProcessingIntent("image/jpeg", "cover")).toBe(true);
		expect(supportsMediaProcessingIntent("video/mp4", "cover")).toBe(true);
		expect(supportsMediaProcessingIntent("audio/mpeg", "cover")).toBe(false);
		expect(supportsMediaProcessingIntent("application/pdf", "cover")).toBe(
			false,
		);
		expect(supportsMediaProcessingIntent("audio/mpeg", "normalize")).toBe(true);
		expect(
			supportsMediaProcessingIntent("application/pdf", "provider_variant"),
		).toBe(false);
	});

	test("deletes an uncommitted generation artifact when projection loses its lease", () => {
		const source = readFileSync(
			join(import.meta.dir, "../workflows/media-processing.ts"),
			"utf8",
		);
		expect(source).toContain(
			"eq(mediaProcessingJobs.leaseToken, claim.generation)",
		);
		expect(source).toContain("MEDIA_BUCKET.delete(processed.storageKey)");
		expect(source).toContain("processingGeneration: String(claim.generation)");
		expect(source).not.toMatch(
			/^\t\tconst db = createDb\(this\.env\.HYPERDRIVE\.connectionString\);$/m,
		);
		expect(
			source.match(
				/const db = createDb\(this\.env\.HYPERDRIVE\.connectionString\);/g,
			),
		).toHaveLength(4);

		const processor = readFileSync(
			join(import.meta.dir, "../../media-processor/server.mjs"),
			"utf8",
		);
		expect(source).toContain("const MAX_PROCESSING_OPTIONS_BYTES = 8 * 1024");
		expect(processor).toContain("const MAX_OPTIONS_BYTES = 8 * 1024");
		expect(processor).toContain('child.stderr.on("data"');
		expect(processor).toContain(
			'setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS)',
		);
	});
});
