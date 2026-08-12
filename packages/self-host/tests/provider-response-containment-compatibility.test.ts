import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host provider response containment compatibility", () => {
	test("inherits the fixed 2 MiB provider-response materialization boundary", async () => {
		const [readme, providerResponse, providerRegistry] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/provider-response.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/db/src/external-provider-retention-registry.ts`,
			).text(),
		]);

		const normalizedProviderResponse = providerResponse.replace(/\s+/g, " ");
		expect(normalizedProviderResponse).toContain(
			"export const PROVIDER_RESPONSE_MAX_BYTES = 2 * 1024 * 1024",
		);
		expect(normalizedProviderResponse).toContain(
			"readResponseJson<T>(response, PROVIDER_RESPONSE_MAX_BYTES)",
		);
		expect(normalizedProviderResponse).toContain(
			"readResponseBytes(response, PROVIDER_RESPONSE_MAX_BYTES)",
		);

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"Provider JSON and diagnostic-text responses materialized inside the API Worker are independently capped at 2 MiB",
		);
		expect(normalizedReadme).toContain(
			"Self-hosted operators need no new setting, binding, secret, or migration for this guard",
		);
		expect(providerRegistry).toContain(
			'sourcePath: "apps/api/src/services/avatar-store.ts"',
		);
		expect(providerRegistry).toContain('marker: "fetchPublicUrl(sourceUrl"');
	});
});
