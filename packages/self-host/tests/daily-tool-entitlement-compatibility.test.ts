import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host daily tool entitlement compatibility", () => {
	it("keeps community tools unlimited while hosted limits remain plan-derived overrides", async () => {
		const [
			config,
			schema,
			usageMeter,
			subscriptionAuthority,
			toolRateLimit,
			deploymentMode,
			apiAuth,
			featureGate,
			apiKeysRoute,
			apiApp,
			dashboardCredential,
			bootstrap,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/config/src/index.ts`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/services/usage-meter.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/subscription-authority.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/middleware/tool-rate-limit.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/deployment-mode.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/middleware/auth.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/middleware/feature-gate.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/api-keys.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/app.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/app/src/lib/dashboard-credential.ts`,
			).text(),
			Bun.file(`${repositoryRoot}scripts/bootstrap-self-host.ts`).text(),
		]);

		expect(config).toContain("freeDailyToolLimit");
		expect(config).toContain("proDailyToolLimit");
		expect(config).toContain("dailyToolLimitForPlan");
		expect(schema).toContain(
			'dailyToolLimitOverride: integer("daily_tool_limit_override"),',
		);
		expect(schema).not.toContain('integer("daily_tool_limit").notNull()');
		expect(usageMeter).toContain("reserveDailyToolUsage");
		expect(usageMeter).toContain("resolveHostedDailyToolLimit");
		expect(usageMeter).toContain("allowDailyToolAuthorityRebase: true");
		expect(usageMeter).toContain("lockOrganizationSubscription");
		expect(subscriptionAuthority).toContain(
			".insert(organizationSubscriptions)",
		);
		expect(subscriptionAuthority).toContain(".onConflictDoNothing");
		expect(subscriptionAuthority).toContain(".for(mode)");
		expect(toolRateLimit).toContain("reserveDailyToolUsage");
		expect(deploymentMode).toContain("dailyToolLimit: null");
		expect(apiAuth).toContain("dailyToolLimitForPlan");
		expect(apiAuth).toContain("isLiveApiKeyPrincipal");
		expect(apiAuth).toContain("eq(apikey.key, hashedKey)");
		expect(featureGate).toContain("if (isSelfHosted(c.env))");
		expect(featureGate).toContain("featureEntitlementsVerified");
		expect(apiKeysRoute).toContain(
			"PostgreSQL is revocation authority. Invalidate its KV projection only",
		);
		expect(apiKeysRoute).toContain(
			"[API Keys] Best-effort KV invalidation failed",
		);
		expect(
			apiApp.indexOf('app.use("/v1/*", dbContextMiddleware)'),
		).toBeLessThan(
			apiApp.indexOf('app.use("/v1/*", timed("auth", authMiddleware))'),
		);
		expect(dashboardCredential).toContain("dailyToolLimitForPlan");
		expect(bootstrap).not.toContain("dailyToolLimit:");
	});
});
