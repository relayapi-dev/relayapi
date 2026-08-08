import { describe, expect, it } from "bun:test";

describe("self-host automation mutation accounting compatibility", () => {
	it("ships exact binding, enrollment, and group-reorder outcomes", async () => {
		const [policy, bindings, automations, runner, ideaGroups] =
			await Promise.all([
				Bun.file(
					new URL(
						"../../../apps/api/src/lib/mutation-effect-policy.ts",
						import.meta.url,
					),
				).text(),
				Bun.file(
					new URL(
						"../../../apps/api/src/routes/automation-bindings.ts",
						import.meta.url,
					),
				).text(),
				Bun.file(
					new URL(
						"../../../apps/api/src/routes/automations.ts",
						import.meta.url,
					),
				).text(),
				Bun.file(
					new URL(
						"../../../apps/api/src/services/automations/runner.ts",
						import.meta.url,
					),
				).text(),
				Bun.file(
					new URL(
						"../../../apps/api/src/routes/idea-groups.ts",
						import.meta.url,
					),
				).text(),
			]);

		expect(policy).toContain("/^\\/v1\\/automation-bindings\\/?$/");
		expect(policy).toContain("/^\\/v1\\/automations\\/[^/]+\\/enroll\\/?$/");
		expect(policy).toContain("/^\\/v1\\/idea-groups\\/reorder\\/?$/");
		expect(bindings).toContain("markBindingMutationNotApplied");
		expect(bindings).toContain("markBindingMutationCommitted");
		expect(automations).toContain("markEnrollmentUnknown");
		expect(runner).toContain("args.onPreflightComplete?.()");
		expect(runner).toContain("args.onAdmissionCommitted?.(inserted.id)");
		expect(ideaGroups).toContain("markIdeaGroupReorderUnknown");
	});
});
