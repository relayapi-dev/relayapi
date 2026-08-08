import { describe, expect, it } from "bun:test";
import { isEmergencySpendMutation } from "../middleware/usage-tracking";
import { assessSpendMutation } from "../services/ad-service";

const running = {
	status: "active",
	dailyBudgetCents: 5_000,
	lifetimeBudgetCents: 50_000,
};

describe("ads emergency spend controls", () => {
	it("allows a post-Pro pause without any spend increase", () => {
		expect(assessSpendMutation(running, { status: "paused" })).toEqual({
			hasIncrease: false,
			hasDecrease: false,
			mixedStopAndIncrease: false,
			emergencySafe: true,
		});
	});

	it("allows lowering either existing budget", () => {
		const result = assessSpendMutation(running, {
			dailyBudgetCents: 4_000,
		});
		expect(result.hasDecrease).toBe(true);
		expect(result.hasIncrease).toBe(false);
		expect(result.emergencySafe).toBe(true);
	});

	it("treats adding a previously absent budget as an increase", () => {
		const result = assessSpendMutation(
			{ ...running, lifetimeBudgetCents: null },
			{ lifetimeBudgetCents: 1_000 },
		);
		expect(result.hasIncrease).toBe(true);
		expect(result.emergencySafe).toBe(false);
	});

	it("rejects the ambiguous pause-plus-increase shape", () => {
		const result = assessSpendMutation(running, {
			status: "paused",
			dailyBudgetCents: 6_000,
		});
		expect(result.mixedStopAndIncrease).toBe(true);
		expect(result.emergencySafe).toBe(false);
	});

	it("does not classify activation, targeting, or naming as emergency-safe", () => {
		expect(
			assessSpendMutation(running, { status: "active" }).emergencySafe,
		).toBe(false);
		expect(
			assessSpendMutation(running, {
				status: "paused",
				hasNonEmergencyChanges: true,
			}).emergencySafe,
		).toBe(false);
	});

	it("bypasses quota only for pure pause/decrease request shapes", () => {
		expect(
			isEmergencySpendMutation(running, { status: "paused" }, [
				"status",
				"daily_budget_cents",
				"lifetime_budget_cents",
			]),
		).toBe(true);
		expect(
			isEmergencySpendMutation(running, { daily_budget_cents: 4_000 }, [
				"status",
				"daily_budget_cents",
				"lifetime_budget_cents",
			]),
		).toBe(true);
		expect(
			isEmergencySpendMutation(
				running,
				{ status: "paused", daily_budget_cents: 6_000 },
				["status", "daily_budget_cents", "lifetime_budget_cents"],
			),
		).toBe(false);
		expect(
			isEmergencySpendMutation(running, { status: "paused", targeting: {} }, [
				"status",
				"daily_budget_cents",
				"lifetime_budget_cents",
			]),
		).toBe(false);
	});

	it("refreshes live billing authority before allowing new or increased spend", async () => {
		const [routes, featureGate] = await Promise.all([
			Bun.file(new URL("../routes/ads.ts", import.meta.url)).text(),
			Bun.file(
				new URL("../middleware/feature-gate.ts", import.meta.url),
			).text(),
		]);
		expect(routes).toContain("await refreshFeatureEntitlements(c)");
		expect(routes).toContain("await requireSpendEligiblePlan(c)");
		expect(routes).toContain("await mayIncreaseSpend(c)");
		expect(routes).toContain('err.code === "PLAN_UPGRADE_REQUIRED"');
		expect(routes).toContain('kind: "not_applied"');
		expect(routes).toContain("response.status === 403");
		expect(featureGate).toContain('c.set("billingSource", billingSource)');
		expect(featureGate).toContain('c.set("billable", billing.billable)');
	});
});
