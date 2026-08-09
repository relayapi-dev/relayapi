import { describe, expect, it } from "bun:test";

describe("self-host automation media compatibility", () => {
	it("resolves durable scoped media through existing storage resources", async () => {
		const [
			readme,
			uploadSchema,
			uploadRoute,
			resolver,
			storageLocator,
			wrangler,
		] = await Promise.all([
			Bun.file(new URL("../README.md", import.meta.url)).text(),
			Bun.file(
				new URL("../../../apps/api/src/schemas/media.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../../../apps/api/src/routes/media.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/services/automations/automation-media.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/services/storage-locator.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL("../../../apps/api/wrangler.jsonc", import.meta.url),
			).text(),
		]);

		expect(readme).toContain(
			"Automation message blocks persist durable `med_*` library IDs",
		);
		expect(readme).toContain("this adds no binding, secret, resource, or");
		expect(readme).toContain("database migration.");
		expect(uploadSchema).toContain(
			'id: z.string().describe("ID of the ready media record")',
		);
		expect(uploadSchema).toContain("original_available: z");
		expect(uploadSchema).toContain("workspace_id: z");
		expect(uploadRoute).toContain("id: mediaId");
		expect(resolver).toContain("eq(media.organizationId, organizationId)");
		expect(resolver).toContain("workspaceCondition");
		expect(resolver).toContain("resolveRelayMediaForPublish");
		expect(storageLocator).toContain("byosPutRetries(body)");
		expect(storageLocator).toContain("? 0");
		expect(readme).toContain("without replaying a consumed request body");
		expect(wrangler).toContain('"binding": "MEDIA_BUCKET"');
		expect(wrangler).toContain('"binding": "HYPERDRIVE"');
		expect(wrangler).not.toContain("AUTOMATION_MEDIA");
	});
});
