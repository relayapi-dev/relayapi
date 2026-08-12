import { describe, expect, it } from "bun:test";
import { adMutationOperations } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	AD_BUDGET_MAX_MINOR_UNITS,
	isSafeAdBudget,
	normalizeSupportedAdCurrency,
} from "../lib/ad-money";
import {
	adMutationStateMatches,
	campaignMutationStateMatches,
	type UpdateAdMutationPayload,
	type UpdateCampaignMutationPayload,
} from "../services/ad-mutation-operations";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "../services/ad-platforms/types";

describe("durable ad mutation operations", () => {
	it("persists target serialization, provider boundary, fencing, and retention", () => {
		const config = getTableConfig(adMutationOperations);
		expect(config.indexes.map((index) => index.config.name)).toEqual(
			expect.arrayContaining([
				"ad_mutation_operations_target_active_uniq",
				"ad_mutation_operations_due_idx",
				"ad_mutation_operations_retention_idx",
			]),
		);
		expect(config.checks.map((check) => check.name)).toEqual(
			expect.arrayContaining([
				"ad_mutation_operations_lease_check",
				"ad_mutation_operations_boundary_check",
				"ad_mutation_operations_projection_check",
			]),
		);
	});

	it("reconciles an ad only when every requested provider field matches", () => {
		const payload: UpdateAdMutationPayload = {
			kind: "update_ad",
			adAccountId: "adacc_1",
			adId: "ad_1",
			campaignId: "camp_1",
			platformAdId: "provider_ad_1",
			changes: { name: "Safe", status: "paused", dailyBudgetCents: 500 },
		};
		expect(
			adMutationStateMatches(payload, {
				exists: true,
				name: "Safe",
				status: "PAUSED",
				dailyBudgetCents: 500,
			}),
		).toBe(true);
		expect(
			adMutationStateMatches(payload, {
				exists: true,
				name: "Safe",
				status: "ACTIVE",
				dailyBudgetCents: 500,
			}),
		).toBe(false);
		expect(
			adMutationStateMatches(
				{
					kind: "cancel_ad",
					adAccountId: "adacc_1",
					adId: "ad_1",
					platformAdId: "provider_ad_1",
				},
				{ exists: false },
			),
		).toBe(true);
	});

	it("requires the campaign hierarchy and every live child before activation", () => {
		const payload: UpdateCampaignMutationPayload = {
			kind: "update_campaign",
			adAccountId: "adacc_1",
			campaignId: "camp_1",
			platformCampaignId: "provider_campaign_1",
			platformAdSetId: "provider_adset_1",
			childPlatformAdIds: ["provider_ad_1"],
			changes: { status: "active" },
		};
		expect(
			campaignMutationStateMatches(
				payload,
				{ exists: true, status: "ACTIVE", adSetStatus: "ACTIVE" },
				[{ exists: true, status: "ACTIVE" }],
			),
		).toBe(true);
		expect(
			campaignMutationStateMatches(
				payload,
				{ exists: true, status: "ACTIVE", adSetStatus: "ACTIVE" },
				[{ exists: true, status: "PAUSED" }],
			),
		).toBe(false);
	});

	it("accepts only exponent-2 provider currencies and int4-safe minor units", () => {
		expect(normalizeSupportedAdCurrency("usd")).toBe("USD");
		expect(normalizeSupportedAdCurrency("JPY")).toBeNull();
		expect(isSafeAdBudget(1)).toBe(true);
		expect(isSafeAdBudget(AD_BUDGET_MAX_MINOR_UNITS)).toBe(true);
		expect(isSafeAdBudget(AD_BUDGET_MAX_MINOR_UNITS + 1)).toBe(false);
		expect(isSafeAdBudget(1.5)).toBe(false);
	});

	it("carries explicit K=0 proof separately from the public ad error code", () => {
		const ordinary = new AdPlatformError(
			"AD_MUTATION_IN_PROGRESS",
			"same-key operation remains active",
		);
		const currentRequestRejected = new AdAuthoritativeNotAppliedError(ordinary);

		expect(currentRequestRejected).toBeInstanceOf(AdPlatformError);
		expect(currentRequestRejected).toBeInstanceOf(
			AdAuthoritativeNotAppliedError,
		);
		expect(currentRequestRejected).toMatchObject({
			code: ordinary.code,
			message: ordinary.message,
		});
		expect(ordinary).not.toBeInstanceOf(AdAuthoritativeNotAppliedError);
	});

	it("records the boundary before provider I/O and projects only after confirmation", async () => {
		const source = await Bun.file(
			new URL("../services/ad-mutation-operations.ts", import.meta.url),
		).text();
		const execution = source.slice(
			source.indexOf("export async function executeAdMutation"),
			source.indexOf("function exactOrIgnored"),
		);
		expect(execution.indexOf("await markBoundary")).toBeLessThan(
			execution.indexOf("await callProvider"),
		);
		expect(execution).toContain('begun.row.phase === "projection"');
		expect(execution).not.toContain("await resolveProviderContext");
		const providerBoundary = execution.slice(
			execution.indexOf("await markBoundary"),
		);
		expect(providerBoundary.indexOf("await confirmProvider")).toBeLessThan(
			providerBoundary.indexOf("await completeProjection"),
		);
	});

	it("passes a fresh boundary callback through the Meta ad-set lookup gap", async () => {
		const source = await Bun.file(
			new URL("../services/ad-mutation-operations.ts", import.meta.url),
		).text();
		const provider = source.slice(
			source.indexOf("async function callProvider"),
			source.indexOf("async function confirmProvider"),
		);
		const budgetPath = provider.slice(
			provider.indexOf("payload.changes.dailyBudgetCents !== undefined"),
			provider.indexOf('case "update_campaign"'),
		);
		expect(budgetPath).toMatch(
			/await context\.adapter\.updateAd\([\s\S]*?targeting: payload\.changes\.targeting,[\s\S]*?async \(\) => \{[\s\S]*?await refreshContext\(\)/,
		);
		expect(budgetPath).toContain("return refreshed.accessToken");
	});

	it("keeps a canonically confirmed projection failure out of provider reconciliation", async () => {
		const source = await Bun.file(
			new URL("../services/ad-mutation-operations.ts", import.meta.url),
		).text();
		const reconciliation = source.slice(
			source.indexOf("export async function reconcileAdMutationOperations"),
			source.indexOf("/** Used by the append-only operator-resolution"),
		);
		const providerFailure = reconciliation.indexOf(
			"await markUnknown(db, claim, error)",
		);
		const projection = reconciliation.indexOf(
			"await completeProjection(db, confirmed.id, confirmed.leaseToken)",
		);
		const projectionFailure = reconciliation.indexOf(
			"await deferProjection(",
			projection,
		);
		expect(providerFailure).toBeGreaterThan(-1);
		expect(providerFailure).toBeLessThan(projection);
		expect(projection).toBeLessThan(projectionFailure);
		const deferProjection = source.slice(
			source.indexOf("async function deferProjection"),
			source.indexOf("async function markUnknown"),
		);
		expect(deferProjection).toContain(
			"claim.row.attempts >= MANUAL_REVIEW_ATTEMPTS",
		);
		expect(deferProjection).toContain(
			'exhausted ? "manual_review" : "pending"',
		);
	});

	it("never replays an operator-confirmed non-effect without a new billed operation", async () => {
		const mutationSource = await Bun.file(
			new URL("../services/ad-mutation-operations.ts", import.meta.url),
		).text();
		const begin = mutationSource.slice(
			mutationSource.indexOf("async function beginMutation"),
			mutationSource.indexOf("async function resolveProviderContext"),
		);
		expect(begin).toContain("operatorResolutionEvidence");
		expect(begin).toContain(
			'terminalOperatorDecision?.action === "mark_not_applied"',
		);
		expect(begin.indexOf("terminalOperatorDecision")).toBeLessThan(
			begin.indexOf('status: "processing"'),
		);
		expect(begin).toContain("settleLinkedDurableUsage");

		const reconciliation = mutationSource.slice(
			mutationSource.indexOf("async function claimForReconciliation"),
			mutationSource.indexOf("/** Used by the append-only operator-resolution"),
		);
		// Discovery prevents starvation; the claim predicate closes the race with
		// an operator transaction that commits after discovery.
		expect(reconciliation.match(/notExists\(/g)).toHaveLength(2);
		expect(reconciliation.match(/"mark_not_applied"/g)).toHaveLength(2);
	});

	it("settles only a different-key conflict reservation as K=0", async () => {
		const mutationSource = await Bun.file(
			new URL("../services/ad-mutation-operations.ts", import.meta.url),
		).text();
		const begin = mutationSource.slice(
			mutationSource.indexOf("async function beginMutation"),
			mutationSource.indexOf("async function resolveProviderContext"),
		);
		const conflictStart = begin.indexOf("if (!sameKey)");
		const conflictAdoption = begin.indexOf(
			"await adoptDurableUsageReservationInTransaction(",
			conflictStart,
		);
		const sameKeyAdoption = begin.indexOf(
			"await adoptDurableUsageReservationInTransaction(",
			conflictAdoption + 1,
		);
		const differentKey = begin.slice(conflictStart, sameKeyAdoption);
		expect(differentKey).toContain("if (active)");
		expect(differentKey).toContain("active.usageReservationId");
		expect(differentKey).toContain("options.usageReservation");
		expect(differentKey).toContain("new AdAuthoritativeNotAppliedError(error)");

		expect(conflictAdoption).toBeGreaterThan(conflictStart);
		expect(sameKeyAdoption).toBeGreaterThan(conflictAdoption);
		expect(begin.slice(sameKeyAdoption)).toContain("operationError(sameKey)");
		expect(
			begin.slice(sameKeyAdoption).indexOf("AdAuthoritativeNotAppliedError"),
		).toBe(-1);
	});

	it("marks exact pre-operation rejections without classifying their codes globally", async () => {
		const [routeSource, serviceSource] = await Promise.all([
			Bun.file(new URL("../routes/ads.ts", import.meta.url)).text(),
			Bun.file(new URL("../services/ad-service.ts", import.meta.url)).text(),
		]);
		const errorHandler = routeSource.slice(
			routeSource.indexOf("function handleAdError"),
			routeSource.indexOf(
				"const status",
				routeSource.indexOf("function handleAdError"),
			),
		);
		expect(errorHandler).toContain(
			"err instanceof AdAuthoritativeNotAppliedError",
		);
		for (const code of [
			"UNSUPPORTED_PLATFORM",
			"UNSUPPORTED_CURRENCY",
			"CURRENCY_MISMATCH",
			"INVALID_BUDGET",
			"INVALID_STATE",
			"NOT_FOUND",
		]) {
			expect(errorHandler).not.toContain(`err.code === "${code}"`);
		}

		const currencyPreflight = serviceSource.slice(
			serviceSource.indexOf("function authoritativeAdCurrency"),
			serviceSource.indexOf("async function getAdAccountContext"),
		);
		expect(
			currencyPreflight.match(/AdAuthoritativeNotAppliedError/g),
		).toHaveLength(4);
		const boostPreflight = serviceSource.slice(
			serviceSource.indexOf("export async function boostPost"),
			serviceSource.indexOf(
				"const operation = await beginAdCreationOperation",
				serviceSource.indexOf("export async function boostPost"),
			),
		);
		expect(boostPreflight).toContain("AdAuthoritativeNotAppliedError");
		expect(boostPreflight).not.toContain(
			'throw new AdPlatformError("NOT_FOUND"',
		);
	});
});
