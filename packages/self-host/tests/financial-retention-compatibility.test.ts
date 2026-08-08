import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host financial retention compatibility", () => {
	it("documents and deploys the same bounded database-owned policy", async () => {
		const [readme, scheduled, service, operatorResolution, schema] =
			await Promise.all([
				Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
				Bun.file(`${repositoryRoot}apps/api/src/scheduled/index.ts`).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/services/financial-retention.ts`,
				).text(),
				Bun.file(
					`${repositoryRoot}apps/api/src/services/operator-resolution.ts`,
				).text(),
				Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			]);

		expect(readme).toContain("deployment-mode neutral");
		expect(readme).toContain("financial_retention_receipts");
		expect(readme).toContain(
			"Unsupported financial Stripe receipts remain parked",
		);
		expect(readme).toContain(
			"Unknown, manual-review, and terminal-failed billing operations",
		);
		expect(readme).toMatch(/Community mode needs no Stripe\s+secret/);
		expect(scheduled).toContain('name: "financial_retention"');
		expect(scheduled).toContain("retainFinancialData(env)");
		expect(service).not.toContain("isSelfHosted");
		expect(service).toContain("FINANCIAL_RETENTION_MAX_PASSES");
		expect(service).not.toContain(
			'"terminal_failed",\n\t\t\t\t\t\t\t"manual_review",',
		);
		expect(operatorResolution).toContain(
			"reconciliation_reference_sha256: providerReferenceDigest",
		);
		expect(operatorResolution).toContain("payload: {}");
		expect(schema).toContain(
			"export const financialRetentionReceipts = pgTable(",
		);
		expect(schema).toContain("IN ('retry', 'abandon')");
	});
});
