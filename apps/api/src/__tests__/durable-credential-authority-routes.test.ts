import { describe, expect, it } from "bun:test";

async function source(path: string): Promise<string> {
	return Bun.file(new URL(path, import.meta.url)).text();
}

function authorityCallCount(value: string): number {
	return value.match(/withCredentialMutationAuthority\s*\(/g)?.length ?? 0;
}

describe("durable configuration credential authority", () => {
	it("commits capability-granting route writes inside the exact issuer fence", async () => {
		const [
			automations,
			automationRunner,
			entrypoints,
			bindings,
			rssRules,
			shortLinks,
			byos,
		] = await Promise.all([
			source("../routes/automations.ts"),
			source("../services/automations/runner.ts"),
			source("../routes/automation-entrypoints.ts"),
			source("../routes/automation-bindings.ts"),
			source("../routes/auto-post-rules.ts"),
			source("../routes/short-links.ts"),
			source("../routes/byos.ts"),
		]);

		expect(authorityCallCount(automations)).toBeGreaterThanOrEqual(3);
		expect(automations).toContain("validateAndActivate(c, tx, id)");
		expect(automations).toContain("sealAutomationGraphSecrets(");
		expect(automations).toContain(
			"withCredentialMutationAuthorityInTransaction(",
		);
		expect(automations).toContain("admissionAuthority: async (tx)");
		expect(automationRunner).toContain("await args.admissionAuthority?.(tx)");
		expect(automationRunner).toContain(
			'admissionAutomation.status !== "active"',
		);
		expect(automationRunner).toContain('.for("update")');
		expect(
			automationRunner.indexOf("await args.admissionAuthority?.(tx)"),
		).toBeLessThan(automationRunner.indexOf("const [admissionAutomation]"));
		expect(
			automationRunner.indexOf("const [admissionAutomation]"),
		).toBeLessThan(automationRunner.indexOf(".insert(automationRuns)"));

		expect(authorityCallCount(entrypoints)).toBeGreaterThanOrEqual(3);
		expect(entrypoints).toMatch(/tx\s*\.insert\(automationEntrypoints\)/);
		expect(entrypoints).toMatch(/tx\s*\.update\(automationEntrypoints\)/);

		expect(authorityCallCount(bindings)).toBeGreaterThanOrEqual(2);
		expect(bindings).toContain('.for("update")');
		expect(bindings).toContain('liveAccount.lifecycleStatus !== "active"');
		expect(bindings).toMatch(/tx\s*\.insert\(automationBindings\)/);

		expect(authorityCallCount(rssRules)).toBeGreaterThanOrEqual(2);
		expect(rssRules).toMatch(/tx\s*\.update\(autoPostRules\)/);

		expect(authorityCallCount(shortLinks)).toBeGreaterThanOrEqual(1);
		expect(shortLinks).toContain("requireAllWorkspaceScope: true");
		expect(shortLinks).toContain(
			"updateVersionedShortLinkConfigInTransaction(tx, orgId",
		);

		expect(authorityCallCount(byos)).toBeGreaterThanOrEqual(3);
		expect(byos).toContain("stageByosConfigurationInTransaction(tx");
		expect(byos).toContain("probeStagedByosConfiguration(");
		expect(byos).toContain(
			"activateProbedByosCredentialInTransaction(tx, probe.claim)",
		);
		expect(byos.match(/requireAllWorkspaceScope: true/g)?.length).toBe(3);
	});

	it("exposes transaction bodies without nesting the service transactions", async () => {
		const [shortLinkService, byosService] = await Promise.all([
			source("../services/short-link-configuration.ts"),
			source("../services/byos-configuration.ts"),
		]);

		expect(shortLinkService).toContain(
			"updateVersionedShortLinkConfigInTransaction",
		);
		expect(shortLinkService).toContain(
			"return db.transaction((tx) =>\n\t\tupdateVersionedShortLinkConfigInTransaction",
		);
		expect(byosService).toContain("stageByosConfigurationInTransaction");
		expect(byosService).toContain("activateProbedByosCredentialInTransaction");
	});

	it("rejects impersonated sessions in request and asynchronous authority fences", async () => {
		const authority = await source("../lib/credential-mutation-authority.ts");

		expect(
			authority.match(/impersonatedBy: authSession\.impersonatedBy/g),
		).toHaveLength(2);
		expect(
			authority.match(/lockedSession\.impersonatedBy !== null/g),
		).toHaveLength(1);
		expect(
			authority.match(/lockedAuthoritySession\.impersonatedBy !== null/g),
		).toHaveLength(1);
	});
});
