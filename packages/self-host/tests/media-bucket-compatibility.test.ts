import { describe, expect, it } from "bun:test";
import { RESOURCE_NAMES } from "../src/constants.js";

/**
 * A self-hosted instance provisions its own media bucket, so anything that
 * signs an R2 URL has to read the bucket from configuration rather than
 * assuming the managed name. This previously went unnoticed because the HEAD
 * used to validate an object routes through the R2 binding (which is correct)
 * while the returned view URL was signed against a hardcoded bucket — so
 * validation passed and every presigned GET 404'd.
 */
describe("self-host media bucket compatibility", () => {
	it("provisions a bucket whose name differs from the managed default", async () => {
		// If these ever converged the regression would become invisible again.
		expect(RESOURCE_NAMES.buckets.media).not.toBe("relayapi-media");
	});

	it("publishes the provisioned bucket to the Worker as R2_MEDIA_BUCKET_NAME", async () => {
		const source = await Bun.file(
			new URL("../src/wrangler-config.ts", import.meta.url),
		).text();
		expect(source).toContain(
			"R2_MEDIA_BUCKET_NAME: RESOURCE_NAMES.buckets.media",
		);
		expect(source).toContain(
			"R2_MEDIA_BUCKET_JURISDICTION: config.cloudflare.r2Jurisdiction",
		);
	});

	it("signs presigned media URLs against the configured bucket, not a constant", async () => {
		const source = await Bun.file(
			new URL("../../../apps/api/src/lib/r2-presign.ts", import.meta.url),
		).text();

		// The signed URL must be built from a location value...
		expect(source).toContain("location.bucket");
		// ...and the persisted row's locator must supply it, so media written
		// before a bucket change still resolves.
		expect(source).toContain("bucket: locator.bucket");
		expect(source).toContain("region: locator.region");
		// The hardcoded name may remain only as a last-resort default, never
		// interpolated straight into the signed URL.
		expect(source).toContain("env.R2_MEDIA_BUCKET_NAME || RELAY_R2_BUCKET");
		expect(source).not.toContain(
			`r2.cloudflarestorage.com/\${RELAY_R2_BUCKET}`,
		);
	});

	it("routes EU-jurisdiction buckets to the EU S3 endpoint", async () => {
		const source = await Bun.file(
			new URL("../../../apps/api/src/lib/r2-presign.ts", import.meta.url),
		).text();
		expect(source).toContain(".eu.r2.cloudflarestorage.com");
	});
});
