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
		expect(providerBoundary.match(/\.for\("share"\)/g)).toHaveLength(2);
		expect(providerBoundary.indexOf(".from(socialAccounts)")).toBeLessThan(
			providerBoundary.indexOf(
				".from(adAccounts)",
				providerBoundary.indexOf(".from(socialAccounts)"),
			),
		);
		expect(providerBoundary).toContain(
			"resolveAdsAccessToken(socialAccount, env)",
		);
		expect(normalizedReadme).toContain(
			"bypasses only the hosted Stripe entitlement check, never actor or provider-account revocation",
		);
		expect(meta).toContain("acknowledgement.success !== true");
		expect(meta).toContain('"META_MUTATION_NOT_ACKNOWLEDGED"');
		expect(meta).toContain("buildTargetingSpec(params.targeting)");
		expect(meta).toContain("Meta targeting does not yet support:");
		expect(meta).toContain('"UNSUPPORTED_TARGETING"');
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
