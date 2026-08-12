import { describe, expect, it } from "bun:test";
import { accountRevocationJobs } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	isCurrentCredentialSource,
	REVOCATION_AUTOMATIC_RETRY_MS,
	revocationNeedsManualReview,
} from "../services/account-revocation";

describe("account revocation recovery policy", () => {
	it("retries automatically for seven days and fences the copied grant", () => {
		const createdAt = new Date("2026-07-20T12:00:00.000Z");
		expect(
			revocationNeedsManualReview(
				createdAt,
				new Date(createdAt.getTime() + REVOCATION_AUTOMATIC_RETRY_MS - 1),
			),
		).toBe(false);
		expect(
			revocationNeedsManualReview(
				createdAt,
				new Date(createdAt.getTime() + REVOCATION_AUTOMATIC_RETRY_MS),
			),
		).toBe(true);
		expect(isCurrentCredentialSource(9, 9)).toBe(true);
		expect(isCurrentCredentialSource(10, 9)).toBe(false);
	});

	it("has an explicit lease token and provider request boundary", () => {
		expect(accountRevocationJobs.accountId.isUnique).toBe(true);
		expect(accountRevocationJobs.leaseToken).toBeDefined();
		expect(accountRevocationJobs.requestMayHaveBeenSentAt).toBeDefined();
		expect(accountRevocationJobs.status.enumValues).toContain("unknown");
		const checks = getTableConfig(accountRevocationJobs).checks.map(
			(item) => item.name,
		);
		expect(checks).toContain(
			"account_revocation_jobs_terminal_redaction_check",
		);
		expect(checks).toContain("account_revocation_jobs_request_boundary_check");
	});

	it("destroys active credentials in every local erasure entrypoint", async () => {
		for (const relativePath of [
			"../lib/delete-account.ts",
			"../services/workspace-erasure.ts",
			"../services/tenant-deletion.ts",
		]) {
			const source = await Bun.file(
				new URL(relativePath, import.meta.url),
			).text();
			expect(source).toContain('lifecycleStatus: "disconnected"');
			expect(source).toContain("accessToken: null");
			expect(source).toContain("refreshToken: null");
			expect(source).toContain("disconnectedAt: now");
		}
	});
});
