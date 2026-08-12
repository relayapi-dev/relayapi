import { describe, expect, test } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host publisher effect recovery compatibility", () => {
	test("inherits fail-closed expired-publish recovery without new resources", async () => {
		const [readme, reconciler] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/self-host/README.md`).text(),
			Bun.file(
				`${repositoryRoot}apps/api/src/services/post-publish-reconciler.ts`,
			).text(),
		]);

		expect(reconciler).toContain("hasMatchingConfirmedEffects(");
		expect(reconciler).toContain('providerDisposition: "partial"');
		expect(reconciler).toContain("RECOVERED_FROM_DURABLE_EFFECTS");
		expect(reconciler).toContain("manual reconciliation is required");
		expect(reconciler.indexOf("if (hasUnknown) {")).toBeLessThan(
			reconciler.indexOf(".insert(publishOutbox)"),
		);

		const normalizedReadme = readme.replace(/\s+/g, " ");
		expect(normalizedReadme).toContain(
			"An effect-bearing attempt becomes `partial` with due read-only reconciliation",
		);
		expect(normalizedReadme).toContain(
			"an effectless ambiguous attempt stays nonterminal and `unknown` for manual resolution, with no provider-write replay",
		);
	});
});
