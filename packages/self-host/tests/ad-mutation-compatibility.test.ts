import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host durable ad-mutation compatibility", () => {
	it("installs the shared provider-first authority without enabling Stripe phone billing", async () => {
		const [
			readme,
			schema,
			mutations,
			creation,
			providerBoundary,
			usage,
			meta,
			google,
			linkedin,
			pinterest,
			tiktok,
			twitter,
			credentials,
			scheduled,
			phones,
			api,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-mutation-operations.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-creation-operations.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-provider-boundary.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/durable-operation-usage.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/meta.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/google.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/linkedin.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/pinterest.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/tiktok.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-platforms/twitter.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/ad-provider-credentials.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/scheduled/index.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/phone-number-operations.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/app.ts`).text(),
		]);
		const normalizedReadme = readme.replace(/\s+/g, " ");

		expect(normalizedReadme).toContain(
			"durable provider-first ad mutation authority",
		);
		expect(schema).toContain("export const adMutationOperations = pgTable(");
		expect(schema).toContain("ad_mutation_operations_target_active_uniq");
		expect(mutations).toContain("reconcileAdMutationOperations");
		expect(mutations.indexOf("await markBoundary")).toBeLessThan(
			mutations.indexOf("await callProvider"),
		);
		expect(providerBoundary).toContain("if (input.requiresLiveEntitlement");
		expect(providerBoundary).toContain("!isSelfHosted(env)");
		expect(providerBoundary).toContain(".from(adConnections)");
		expect(providerBoundary).toContain("accountAuthorityCondition");
		expect(providerBoundary).toContain("resolveAdProviderCredentials({");
		expect(credentials).toContain("if (input.adConnection)");
		expect(credentials).toContain('input.platform === "meta"');
		expect(credentials).toContain('"ADS_CONNECTION_REQUIRED"');
		expect(normalizedReadme).toContain(
			"bypasses only the hosted Stripe entitlement check, never actor, connection, scope, or provider-account revocation",
		);
		expect(meta).toContain("acknowledgement.success !== true");
		expect(meta).toContain('"META_MUTATION_NOT_ACKNOWLEDGED"');
		expect(meta).toContain("buildCompleteTargetingSpec(params.targeting)");
		expect(meta).toContain("Meta requires a geography in every targeting spec");
		expect(google).toContain("containsEuPoliticalAdvertising");
		expect(google).toContain("createCreativeAndAd");
		expect(linkedin).toContain('requiredScopes: ["rw_ads"]');
		expect(linkedin).toContain('"X-RestLi-Method": "PARTIAL_UPDATE"');
		expect(normalizedReadme).toContain(
			"paid-write adapters for Google Ads v25, LinkedIn Marketing API 202607, Pinterest Ads v5, TikTok Marketing API v1.3, and X Ads API v12",
		);
		expect(normalizedReadme).toContain(
			"no extra Cloudflare binding is required",
		);
		expect(pinterest).toContain("coalescesCreativeAndAd: true");
		expect(pinterest).toContain('"/ads", "POST"');
		expect(tiktok).toContain('"ad/status/update"');
		expect(tiktok).toContain("code !== 0");
		expect(twitter).toContain('"DELETE"');
		expect(twitter).toContain("promoted_tweets");
		expect(creation).toContain("hasAdCreationProviderEffect(operation)");
		expect(usage).toContain("adCreationUsesInheritedContext");
		expect(normalizedReadme).toContain("IDs inherited from an existing");
		expect(normalizedReadme).toContain(
			"context, not a billable provider effect",
		);
		expect(scheduled).toContain('name: "ad_mutations"');
		expect(phones).toContain("if (isSelfHosted(env))");
		expect(normalizedReadme).toContain(
			"financial role immediately blocks replay of an earlier paid-operation response",
		);
		expect(api.indexOf("requireManageSpendMiddleware")).toBeLessThan(
			api.indexOf('timed("idempotency", idempotencyMiddleware)'),
		);
	});
});
