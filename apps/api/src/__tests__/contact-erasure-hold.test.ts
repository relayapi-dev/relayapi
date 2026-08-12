import { describe, expect, it } from "bun:test";
import {
	ContactErasureHeldError,
	ContactErasureScopeChangedError,
	lockContactErasureScope,
} from "../services/contact-erasure";

function queryBuilder(
	result: readonly Record<string, unknown>[],
	log: string[],
) {
	// biome-ignore lint/suspicious/noExplicitAny: intentionally tiny Drizzle test double
	const query: any = Promise.resolve(result);
	Object.assign(query, {
		from: () => {
			log.push("from");
			return query;
		},
		where: () => {
			log.push("where");
			return query;
		},
		orderBy: () => {
			log.push("orderBy");
			return query;
		},
		for: (mode: string) => {
			log.push(`for:${mode}`);
			return query;
		},
		limit: async () => result,
	});
	return query;
}

function holdGateTx(
	results: readonly (readonly Record<string, unknown>[])[],
	log: string[],
) {
	let index = 0;
	return {
		select: () => queryBuilder(results[index++] ?? [], log),
		// biome-ignore lint/suspicious/noExplicitAny: only select is exercised
	} as any;
}

describe("contact-erasure-hold-linearization", () => {
	it("takes tenant roots before reading the active hold and rejects deletion", async () => {
		const log: string[] = [];
		await expect(
			lockContactErasureScope(
				holdGateTx(
					[[{ id: "org_1" }], [{ id: "ws_1" }], [{ id: "hold_1" }]],
					log,
				),
				{
					organizationId: "org_1",
					workspaceIds: ["ws_1"],
					contactIds: ["ct_1"],
				},
			),
		).rejects.toBeInstanceOf(ContactErasureHeldError);
		expect(log.filter((event) => event === "for:share")).toHaveLength(2);
		expect(log.lastIndexOf("for:share")).toBeLessThan(
			log.lastIndexOf("orderBy"),
		);
	});

	it("returns a scope capability only after a clear hold decision", async () => {
		const log: string[] = [];
		const authority = await lockContactErasureScope(
			holdGateTx([[{ id: "org_1" }], [{ id: "ws_1" }], []], log),
			{
				organizationId: "org_1",
				workspaceIds: ["ws_1", "ws_1", null],
				contactIds: ["ct_2", "ct_1"],
			},
		);
		expect(authority).toMatchObject({
			organizationId: "org_1",
			workspaceIds: ["ws_1"],
			contactIds: ["ct_1", "ct_2"],
		});
	});

	it("fails closed if an expected workspace root changed or disappeared", async () => {
		await expect(
			lockContactErasureScope(holdGateTx([[{ id: "org_1" }], [], []], []), {
				organizationId: "org_1",
				workspaceIds: ["ws_missing"],
				contactIds: ["ct_1"],
			}),
		).rejects.toBeInstanceOf(ContactErasureScopeChangedError);
	});

	it("keeps root-first ordering in single, bulk, and automation writers", async () => {
		const [routes, action, erasure, actionGroup] = await Promise.all([
			Bun.file(new URL("../routes/contacts.ts", import.meta.url)).text(),
			Bun.file(
				new URL("../services/automations/actions/contact.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/contact-erasure.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../services/automations/nodes/action-group.ts",
					import.meta.url,
				),
			).text(),
		]);
		const singleStart = routes.indexOf("app.openapi(deleteContact");
		const singleDelete = routes.slice(
			singleStart,
			routes.indexOf("app.openapi(listChannels", singleStart),
		);
		const bulkStart = routes.indexOf('if (body.action === "delete")');
		const bulkDelete = routes.slice(
			bulkStart,
			routes.indexOf('} else if (body.action === "add_tags"', bulkStart),
		);
		const automationStart = action.indexOf("const deleteContact:");
		const automationDelete = action.slice(automationStart);
		for (const source of [singleDelete, bulkDelete, automationDelete]) {
			expect(source.indexOf("lockContactErasureScope")).toBeGreaterThanOrEqual(
				0,
			);
			expect(source.indexOf("lockContactErasureScope")).toBeLessThan(
				source.indexOf('.for("update")'),
			);
		}
		expect(erasure.indexOf('.for("share")')).toBeLessThan(
			erasure.indexOf(".from(erasureHolds)"),
		);
		expect(erasure).toContain('readonly code = "CONTACT_ERASURE_HELD"');
		expect(routes).toContain("error instanceof ContactErasureHeldError");
		// A hold error is an ordinary business/action failure, so action_group
		// persists it and follows its bounded error policy rather than throwing a
		// busy/unknown control error that would be retried.
		expect(actionGroup).toContain("isAutomationExternalEffectControlError");
		expect(actionGroup).toContain('abortedByError ? "error" : "next"');
	});
});
