import { describe, expect, it } from "bun:test";
import { getMutationEffectCoveragePolicy } from "../lib/mutation-effect-policy";

function handlerSlice(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex);
	expect(startIndex).toBeGreaterThan(-1);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

function occurrences(source: string, value: string): number {
	return source.split(value).length - 1;
}

describe("automation route mutation accounting", () => {
	it("classifies only the audited automation mutation routes as tracked complete", () => {
		const routes: ReadonlyArray<readonly [string, string]> = [
			["POST", "/v1/automation-bindings"],
			["PATCH", "/v1/automation-bindings/bind_1"],
			["DELETE", "/v1/automation-bindings/bind_1"],
			["POST", "/v1/automations/auto_1/enroll"],
			["POST", "/v1/idea-groups/reorder"],
		];
		for (const [method, path] of routes) {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe(
				"tracked_complete",
			);
		}

		for (const [method, path] of [
			["PUT", "/v1/automation-bindings/bind_1"],
			["POST", "/v1/automation-bindings/bind_1/sync"],
			["POST", "/v1/automations/auto_1/enroll/extra"],
			["POST", "/v1/idea-groups/reorder/extra"],
		] as const) {
			expect(getMutationEffectCoveragePolicy(method, path)).toBe("incomplete");
		}
	});

	it("enumerates every automation-binding mutation outcome", async () => {
		const source = await Bun.file(
			new URL("../routes/automation-bindings.ts", import.meta.url),
		).text();

		const notAppliedHelper = handlerSlice(
			source,
			"function markBindingMutationNotApplied",
			"function markBindingMutationCommitted",
		);
		expect(notAppliedHelper).toContain('kind: "not_applied"');
		const committedHelper = handlerSlice(
			source,
			"function markBindingMutationCommitted",
			"async function loadScopedBinding",
		);
		expect(committedHelper).toContain('kind: "committed"');
		expect(committedHelper).toContain("units: 1");

		const create = handlerSlice(
			source,
			"app.openapi(createBinding",
			"const getBinding",
		);
		expect(occurrences(create, "markBindingMutationNotApplied(c)")).toBe(15);
		expect(occurrences(create, "markBindingMutationCommitted(c)")).toBe(1);
		expect(occurrences(create, "return c.json")).toBe(15);
		expect(occurrences(create, "return denied")).toBe(1);
		expect(occurrences(create, "throw err")).toBe(1);
		expect(create.indexOf("markBindingMutationCommitted(c)")).toBeGreaterThan(
			create.indexOf("if (!inserted)"),
		);
		expect(create.indexOf("markBindingMutationCommitted(c)")).toBeLessThan(
			create.indexOf("enqueueProviderSyncSafely(c, inserted)"),
		);

		const update = handlerSlice(
			source,
			"app.openapi(updateBinding",
			"const deleteBinding",
		);
		expect(occurrences(update, "markBindingMutationNotApplied(c)")).toBe(10);
		expect(occurrences(update, "markBindingMutationCommitted(c)")).toBe(1);
		expect(occurrences(update, "return c.json")).toBe(8);
		expect(occurrences(update, "return notFound(c)")).toBe(2);
		expect(occurrences(update, "return scoped.denied")).toBe(1);
		expect(update.indexOf("markBindingMutationCommitted(c)")).toBeGreaterThan(
			update.indexOf('if (result.kind === "not_found")'),
		);
		expect(update.indexOf("markBindingMutationCommitted(c)")).toBeLessThan(
			update.indexOf("enqueueProviderSyncSafely(c, result.row)"),
		);

		const remove = handlerSlice(
			source,
			"app.openapi(deleteBinding",
			"// Binding insights",
		);
		expect(occurrences(remove, "markBindingMutationNotApplied(c)")).toBe(3);
		expect(occurrences(remove, "markBindingMutationCommitted(c)")).toBe(2);
		expect(occurrences(remove, "return notFound(c)")).toBe(1);
		expect(occurrences(remove, "return scoped.denied")).toBe(1);
		expect(occurrences(remove, "return c.body(null, 204)")).toBe(1);
		expect(remove).toContain(".returning({ id: automationBindings.id })");
		expect(remove.indexOf("markBindingMutationCommitted(c)")).toBeLessThan(
			remove.indexOf("enqueueProviderSyncSafely(c, updated)"),
		);
	});

	it("separates enrollment preflight, admission, and inline-execution outcomes", async () => {
		const routeSource = await Bun.file(
			new URL("../routes/automations.ts", import.meta.url),
		).text();
		const handler = handlerSlice(
			routeSource,
			"app.openapi(enrollAutomation",
			"const simulateAutomationRoute",
		);
		expect(occurrences(handler, "markEnrollmentNotApplied(c)")).toBe(5);
		expect(occurrences(handler, "markEnrollmentCommitted(c)")).toBe(1);
		expect(occurrences(handler, "markEnrollmentUnknown(c)")).toBe(1);
		expect(occurrences(handler, "return c.json")).toBe(5);
		expect(occurrences(handler, "return notFound(c)")).toBe(1);
		expect(occurrences(handler, "onPreflightComplete")).toBe(1);
		expect(occurrences(handler, "onAdmissionCommitted")).toBe(1);
		expect(occurrences(handler, "admissionAuthority")).toBe(1);
		expect(handler).toContain("} else if (!admissionCommitted) {");

		const runnerSource = await Bun.file(
			new URL("../services/automations/runner.ts", import.meta.url),
		).text();
		const enroll = handlerSlice(
			runnerSource,
			"export async function enrollContact",
			"export async function resumeExternalEventRuns",
		);
		expect(occurrences(enroll, "onPreflightComplete")).toBe(2);
		expect(occurrences(enroll, "onAdmissionCommitted")).toBe(2);
		expect(occurrences(enroll, "admissionAuthority")).toBe(2);
		expect(enroll.indexOf("args.onPreflightComplete?.()")).toBeLessThan(
			enroll.indexOf("admissionResult = await db.transaction"),
		);
		expect(enroll.indexOf("args.onAdmissionCommitted?.(inserted.id)")).toBe(
			enroll.lastIndexOf("args.onAdmissionCommitted?.(inserted.id)"),
		);
		expect(
			enroll.indexOf("args.onAdmissionCommitted?.(inserted.id)"),
		).toBeLessThan(enroll.indexOf("await runLoop("));
	});

	it("tracks the raw-SQL idea-group reorder transaction explicitly", async () => {
		const source = await Bun.file(
			new URL("../routes/idea-groups.ts", import.meta.url),
		).text();
		const handler = handlerSlice(
			source,
			"app.openapi(reorderIdeaGroups",
			"export {",
		);
		expect(source).toContain("class IdeaGroupReorderFenceError extends Error");
		expect(occurrences(handler, "markIdeaGroupReorderNotApplied(c)")).toBe(2);
		expect(occurrences(handler, "markIdeaGroupReorderCommitted(c)")).toBe(1);
		expect(occurrences(handler, "markIdeaGroupReorderUnknown(c)")).toBe(1);
		expect(occurrences(handler, 'return { kind: "conflict" } as const')).toBe(
			2,
		);
		expect(occurrences(handler, "await tx.execute")).toBe(2);
		expect(occurrences(handler, "return denied")).toBe(1);
		expect(occurrences(handler, "return c.json")).toBe(2);
		expect(handler.indexOf("markIdeaGroupReorderUnknown(c)")).toBeLessThan(
			handler.indexOf("throw error"),
		);
		expect(handler).toContain(
			"if (error instanceof IdeaGroupReorderFenceError)",
		);
		expect(
			handler.indexOf("if (error instanceof IdeaGroupReorderFenceError)"),
		).toBeLessThan(handler.indexOf("markIdeaGroupReorderUnknown(c)"));
		expect(
			handler.indexOf("markIdeaGroupReorderNotApplied(c)", 1),
		).toBeLessThan(handler.indexOf("REVISION_CONFLICT"));
		expect(handler.indexOf("markIdeaGroupReorderCommitted(c)")).toBeGreaterThan(
			handler.indexOf('if (result.kind === "conflict")'),
		);
	});
});
