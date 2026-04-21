// Port-handles tests (Plan 2 — Unit B2, Task L1).
//
// NOTE: React Testing Library is not installed in apps/app; Bun's built-in
// test runner is used across the builder tests. Until RTL lands, we exercise
// the pure helpers (port style lookup + vertical spacing) directly instead of
// rendering through React Flow. This still covers the behaviour the spec
// calls out — role→color mapping, sub-role resolution for branch "true" /
// "false", and even distribution of multi-output handles — without pulling
// a DOM stack into the test runner.
//
// When RTL is added, a full render test should be added here that asserts
// `<Handle>` counts, ids, and data-* attributes on a 3-output node.

import { describe, expect, it } from "bun:test";
import {
	portHandleTop,
	stylesForPort,
} from "./port-handles";
import { derivePorts } from "./derive-ports";

describe("stylesForPort", () => {
	it("uses green for condition true branch", () => {
		const style = stylesForPort({
			key: "true",
			direction: "output",
			role: "branch",
		});
		expect(style.dot).toContain("#1fa971");
	});

	it("uses red for condition false branch", () => {
		const style = stylesForPort({
			key: "false",
			direction: "output",
			role: "branch",
		});
		expect(style.dot).toContain("#d64545");
	});

	it("uses purple for non-true/false branch roles", () => {
		const style = stylesForPort({
			key: "variant.a",
			direction: "output",
			role: "branch",
			label: "A",
		});
		expect(style.dot).toContain("#7c4dff");
	});

	it("maps error and invalid roles to red", () => {
		expect(
			stylesForPort({ key: "error", direction: "output", role: "error" }).dot,
		).toContain("#d64545");
		expect(
			stylesForPort({
				key: "invalid",
				direction: "output",
				role: "invalid",
			}).dot,
		).toContain("#d64545");
	});

	it("maps success role to green", () => {
		const style = stylesForPort({
			key: "success",
			direction: "output",
			role: "success",
		});
		expect(style.dot).toContain("#1fa971");
	});

	it("maps interactive role to blue", () => {
		const style = stylesForPort({
			key: "button.cta",
			direction: "output",
			role: "interactive",
			label: "CTA",
		});
		expect(style.dot).toContain("#2f6bff");
	});

	it("maps timeout role to amber", () => {
		const style = stylesForPort({
			key: "timeout",
			direction: "output",
			role: "timeout",
		});
		expect(style.dot).toContain("#c78028");
	});

	it("maps skip role to neutral", () => {
		const style = stylesForPort({
			key: "skip",
			direction: "output",
			role: "skip",
		});
		expect(style.dot).toContain("#b7bdc9");
	});

	it("maps unknown role to neutral grey", () => {
		const style = stylesForPort({ key: "next", direction: "output" });
		expect(style.dot).toContain("#98a6bd");
	});
});

describe("portHandleTop", () => {
	it("centres a single handle", () => {
		expect(portHandleTop(0, 1)).toBe("50%");
	});

	it("distributes three handles evenly", () => {
		const top0 = portHandleTop(0, 3);
		const top1 = portHandleTop(1, 3);
		const top2 = portHandleTop(2, 3);
		expect(top0).toBe("18%");
		expect(top1).toBe("50%");
		expect(top2).toBe("82%");
	});
});

describe("derivePorts x port-handles", () => {
	it("a condition node renders 1 input + 2 branch outputs", () => {
		const ports = derivePorts({ kind: "condition", config: {} });
		const inputs = ports.filter((p) => p.direction === "input");
		const outputs = ports.filter((p) => p.direction === "output");
		expect(inputs.length).toBe(1);
		expect(outputs.length).toBe(2);
		expect(outputs.map((p) => p.key).sort()).toEqual(["false", "true"]);
		expect(stylesForPort(outputs[0]!).dot).toMatch(/#1fa971|#d64545/);
	});

	it("a message node with two branch buttons yields 3 output handles", () => {
		const ports = derivePorts({
			kind: "message",
			config: {
				blocks: [
					{
						type: "text",
						buttons: [
							{ id: "yes", type: "branch", label: "Yes" },
							{ id: "no", type: "branch", label: "No" },
						],
					},
				],
			},
		});
		const outputs = ports.filter((p) => p.direction === "output");
		// next + 2 branch buttons = 3 outputs
		expect(outputs.length).toBe(3);
		expect(outputs.map((p) => p.key)).toEqual([
			"next",
			"button.yes",
			"button.no",
		]);
	});
});
