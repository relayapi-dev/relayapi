import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host durable credential-authority compatibility", () => {
	test("ships the shared transaction fences without a new binding", async () => {
		const [
			automations,
			entrypoints,
			bindings,
			rssRules,
			shortLinks,
			byos,
			automationRunner,
			wrangler,
		] = await Promise.all([
			Bun.file(`${repositoryRoot}apps/api/src/routes/automations.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/routes/automation-entrypoints.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/routes/automation-bindings.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/routes/auto-post-rules.ts`,
			).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/short-links.ts`).text(),
			Bun.file(`${repositoryRoot}apps/api/src/routes/byos.ts`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/automations/runner.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}packages/self-host/src/wrangler-config.ts`,
			).text(),
		]);

		for (const route of [
			automations,
			entrypoints,
			bindings,
			rssRules,
			shortLinks,
			byos,
		]) {
			expect(route).toContain("withCredentialMutationAuthority");
		}
		expect(shortLinks).toContain("requireAllWorkspaceScope: true");
		expect(byos.match(/requireAllWorkspaceScope: true/g)?.length).toBe(3);
		expect(byos).toContain(
			"activateProbedByosCredentialInTransaction(tx, probe.claim)",
		);
		expect(automations).toContain(
			"withCredentialMutationAuthorityInTransaction(",
		);
		expect(automationRunner).toContain("await args.admissionAuthority?.(tx)");
		expect(automationRunner).toContain(
			'admissionAutomation.status !== "active"',
		);
		expect(wrangler).not.toContain("CREDENTIAL_MUTATION_AUTHORITY");
	});
});
