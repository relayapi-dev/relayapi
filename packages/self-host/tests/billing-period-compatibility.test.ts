import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host billing-period compatibility", () => {
	it("keeps community quota explicit and installs the shared authority model", async () => {
		const [
			readme,
			deploymentMode,
			dashboardCredential,
			schema,
			usageMeter,
			usageTracking,
			adminRoute,
			usageProjection,
			usageCarryover,
			billingPeriods,
			invoiceGenerator,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/lib/deployment-mode.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/app/src/lib/dashboard-credential.ts`,
			).text(),
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/services/usage-meter.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/middleware/usage-tracking.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/admin.ts`).text(),
			Bun.file(
				`${repositoryRoot}packages/db/scripts/render-usage-bucket-projection-sql.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/usage-carryover.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/billing-periods.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/invoice-generator.ts`,
			).text(),
		]);

		expect(readme).toContain("`quota_mode='unlimited'`");
		expect(readme).toContain("`included_units=NULL`");
		expect(deploymentMode).toContain('quotaMode: "unlimited"');
		expect(deploymentMode).toContain("callsIncluded: null");
		expect(deploymentMode).not.toContain("MAX_SAFE_INTEGER");
		expect(dashboardCredential).not.toContain("MAX_SAFE_INTEGER");
		expect(schema).toContain("export const billingPeriods = pgTable(");
		expect(schema).toContain("billing_periods_org_start_live_uniq");
		expect(schema).toContain("usage_buckets_metered_authority_check");
		expect(readme).toContain("rolls back the stale bucket transaction");
		expect(readme).toContain("delete-invalidates the affected API-key caches");
		expect(usageMeter).toContain(
			"export async function resolveSuccessfulMutationAuthority(",
		);
		expect(usageMeter).toContain(
			"const resolution = await resolveSuccessfulMutationAuthority(",
		);
		expect(usageMeter).toContain("selfHealed: true");
		expect(usageMeter).toContain("metric !== METRIC");
		expect(usageMeter).not.toContain("DEPLOYMENT_MODE");
		expect(usageTracking).toContain("decision.selfHealed");
		expect(usageTracking).toContain("`apikey:${");
		expect(usageTracking).not.toContain("DEPLOYMENT_MODE");
		expect(adminRoute.indexOf("await setComplimentaryPlan")).toBeLessThan(
			adminRoute.indexOf("const invalidations = await Promise.allSettled"),
		);
		expect(usageProjection).toContain("pg_trigger_depth() < 2");
		expect(usageProjection).toContain("COALESCE(current_setting(");
		expect(usageProjection).toContain("contract.ownershipMarker");
		expect(usageProjection).toContain(", true), 'off') <> 'on'");
		expect(schema).toContain(
			"export const usageReservationCarryovers = pgTable(",
		);
		expect(readme).toContain("temporarily holds the original N units");
		expect(usageCarryover).toContain("effectiveCarryoverAllowance");
		expect(billingPeriods).toContain("createUsageReservationCarryovers");
		expect(invoiceGenerator).toContain("carryover.pendingUnits > 0");
	});
});
