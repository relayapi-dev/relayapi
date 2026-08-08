import { describe, expect, it } from "bun:test";

describe("self-host mutation-effect compatibility", () => {
	it("ships the same monotonic request evidence and ledger vocabulary", async () => {
		const [
			tracker,
			policy,
			providerBoundary,
			schema,
			usage,
			inboxFeed,
			tags,
			templates,
			fields,
		] = await Promise.all([
			Bun.file(
				new URL(
					"../../../apps/api/src/lib/mutation-effect.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/lib/mutation-effect-policy.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/lib/mutation-provider-boundary.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(new URL("../../db/src/schema.ts", import.meta.url)).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/services/usage-meter.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL("../../../apps/api/src/routes/inbox-feed.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../../../apps/api/src/routes/tags.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/routes/content-templates.ts",
					import.meta.url,
				),
			).text(),
			Bun.file(
				new URL(
					"../../../apps/api/src/routes/custom-fields.ts",
					import.meta.url,
				),
			).text(),
		]);

		expect(tracker).toContain("class MutationEffectTracker");
		expect(tracker).toContain("isProvenNotApplied");
		expect(tracker).toContain(
			'if (this.#attempts.size === 0) return { kind: "not_applied" };',
		);
		expect(policy).toContain("getMutationEffectCoveragePolicy");
		expect(policy).toContain("tracked_complete");
		expect(policy).toContain("/^\\/v1\\/contacts");
		expect(policy).not.toContain("/^\\/v1\\/ads");
		expect(providerBoundary).toContain("trackSingleUnitProviderMutation");
		expect(providerBoundary).toContain("SingleUnitProviderMutationAggregate");
		expect(schema).toContain('"proven_not_applied"');
		expect(schema).toContain("requestMayHaveBeenSentAt} IS NOT NULL");
		expect(usage).toContain('reason: "proven_not_applied"');
		expect(inboxFeed).toContain("SingleUnitProviderMutationAggregate");
		expect(inboxFeed).toContain("trackedProviderFetch(");
		for (const auditedRoute of [tags, templates, fields]) {
			expect(auditedRoute).toContain(".returning({ id:");
			expect(auditedRoute).toContain("if (!deleted)");
		}
	});
});
