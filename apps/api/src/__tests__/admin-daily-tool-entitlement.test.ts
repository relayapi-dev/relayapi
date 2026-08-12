import { describe, expect, it } from "bun:test";
import { AdminOrganization, AdminOrganizationUpdate } from "../schemas/admin";

describe("admin daily tool entitlement contract", () => {
	it("accepts explicit zero and nullable plan-default reset only", () => {
		expect(
			AdminOrganizationUpdate.safeParse({ dailyToolLimitOverride: 0 }).success,
		).toBe(true);
		expect(
			AdminOrganizationUpdate.safeParse({ dailyToolLimitOverride: null })
				.success,
		).toBe(true);
		expect(
			AdminOrganizationUpdate.safeParse({ dailyToolLimitOverride: -1 }).success,
		).toBe(false);
		expect(
			AdminOrganizationUpdate.safeParse({ dailyToolLimitOverride: 1.5 })
				.success,
		).toBe(false);
	});

	it("returns both effective and override values to distinguish inheritance", () => {
		const base = {
			id: "org_test",
			name: "Test",
			slug: "test",
			logo: null,
			createdAt: "2026-07-29T00:00:00.000Z",
			memberCount: 1,
			plan: "pro" as const,
			subscriptionStatus: "active",
			basePriceCents: 500,
			apiCallsUsed: 0,
			apiCallsIncluded: 10_000,
			aiEnabled: false,
		};
		expect(
			AdminOrganization.parse({
				...base,
				dailyToolLimit: 10,
				dailyToolLimitOverride: null,
			}),
		).toMatchObject({
			dailyToolLimit: 10,
			dailyToolLimitOverride: null,
		});
		expect(
			AdminOrganization.parse({
				...base,
				dailyToolLimit: 25,
				dailyToolLimitOverride: 25,
			}),
		).toMatchObject({
			dailyToolLimit: 25,
			dailyToolLimitOverride: 25,
		});
	});

	it("keeps API, SDK, dashboard proxy, and UI management surfaces in parity", async () => {
		const [route, sdk, proxy, ui] = await Promise.all([
			Bun.file(new URL("../routes/admin.ts", import.meta.url)).text(),
			Bun.file(
				new URL(
					"../../../../packages/sdk/src/resources/admin.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../app/src/pages/api/admin/organizations.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../app/src/components/dashboard/pages/admin/admin-organizations-page.tsx",
					import.meta.url,
				),
			).text(),
		]);
		expect(route).toContain("dailyToolLimitForPlan");
		expect(route).toContain("dailyToolLimitOverride");
		expect(route).toContain(".onConflictDoUpdate");
		expect(sdk).toContain("dailyToolLimitOverride?: number | null");
		expect(sdk).toContain("dailyToolLimit: number");
		expect(proxy).toContain("dailyToolLimitOverride");
		expect(ui).toContain("Daily tool limit override");
		expect(ui).toContain("Leave blank to inherit the current plan");
	});
});
