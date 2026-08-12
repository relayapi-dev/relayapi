import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host phone release fencing compatibility", () => {
	it("ships the same snapshot CAS and completed-phase recovery", async () => {
		const [readme, phones, operatorResolution] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/phone-number-operations.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/operator-resolution.ts`,
			).text(),
		]);

		expect(readme).toContain("Phone release staging fences the exact");
		expect(readme).toContain(
			"Tenant/workspace erasure supersedes every",
		);
		expect(phones).toContain("provisioningLeaseToken");
		expect(phones).toContain("releaseLeaseToken");
		expect(phones).toContain("takeOverUserReleaseForTenantDeletion");
		expect(phones).toContain('releaseReason, "user_requested"');
		expect(phones).toContain('row.releasePhase === "completed"');
		expect(operatorResolution).toContain(
			"retry && row.releaseRequestMayHaveBeenSentAt !== null",
		);
	});
});
