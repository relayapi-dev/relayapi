import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host timed-domain retention compatibility", () => {
	it("uses the same daily executor and existing thumbnail cleanup authority", async () => {
		const [readme, scheduled, service] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/scheduled/index.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/timed-domain-retention.ts`,
			).text(),
		]);

		expect(readme).toContain(
			"The remaining domain retention clocks are deployment-mode neutral",
		);
		expect(readme).toContain("No self-host-only setting");
		expect(scheduled).toContain('name: "timed_domain_retention"');
		expect(scheduled).toContain("retainTimedDomainData(env)");
		expect(service).not.toContain("isSelfHosted");
		expect(service).toContain(".insert(externalSubjectCleanupJobs)");
		expect(service).toContain('bucket: "thumbnail"');
	});
});
