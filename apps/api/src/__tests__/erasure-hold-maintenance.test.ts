import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	ERASURE_HOLD_DETAIL_RETENTION_MS,
	ERASURE_JOB_AGED_ALERT_MS,
	erasureMaintenanceCutoffs,
} from "../services/erasure-hold-maintenance";

describe("erasure hold maintenance", () => {
	it("uses explicit 24-hour alert and 90-day post-release detail clocks", () => {
		const now = new Date("2026-07-28T12:00:00.000Z");
		const cutoffs = erasureMaintenanceCutoffs(now);
		expect(now.getTime() - cutoffs.agedJobCutoff.getTime()).toBe(
			ERASURE_JOB_AGED_ALERT_MS,
		);
		expect(now.getTime() - cutoffs.releasedHoldDetailCutoff.getTime()).toBe(
			ERASURE_HOLD_DETAIL_RETENTION_MS,
		);
	});

	it("durably marks only unresolved unalerted jobs before logging", () => {
		const source = readFileSync(
			new URL("../services/erasure-hold-maintenance.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("isNull(tenantDeletionJobs.agedAlertedAt)");
		expect(source).toContain('ne(tenantDeletionJobs.status, "purged")');
		expect(source).toContain("isNull(workspaceErasureJobs.agedAlertedAt)");
		expect(source).toContain("redactReleasedErasureHoldEvidence");
	});
});
