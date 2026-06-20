// Port-handles tests (Plan 2 — Unit B2, Task L1).
//
// NOTE: React Testing Library is not installed in apps/app; Bun's built-in
// test runner is used across the builder tests. Until RTL lands, we exercise
// the pure helpers (port style lookup + vertical spacing) directly instead of
// rendering through React Flow. This still covers the behaviour the spec
// calls out — the monochrome port style contract and even distribution of
// multi-output handles — without pulling a DOM stack into the test runner.
//
// When RTL is added, a full render test should be added here that asserts
// `<Handle>` counts, ids, and data-* attributes on a 3-output node.

import { describe, expect, it } from "bun:test";
import {
	portHandleTop,
	stylesForPort,
} from "./port-handles";
import { derivePorts } from "./derive-ports";
import type { AutomationPort } from "./graph-types";

describe("stylesForPort", () => {
	// Monochrome by design: every role shares one neutral dot/chip treatment.
	// The chip *label* (e.g. "True", "False", "Error") carries the meaning, so
	// the canvas stays calm without a rainbow of port colours. These tests pin
	// that contract — if a future variant reintroduces per-role colour cues,
	// update them deliberately.
	const ROLES: AutomationPort[] = [
		{ key: "true", direction: "output", role: "branch" },
		{ key: "false", direction: "output", role: "branch" },
		{ key: "variant.a", direction: "output", role: "branch", label: "A" },
		{ key: "error", direction: "output", role: "error" },
		{ key: "invalid", direction: "output", role: "invalid" },
		{ key: "success", direction: "output", role: "success" },
		{ key: "button.cta", direction: "output", role: "interactive", label: "CTA" },
		{ key: "timeout", direction: "output", role: "timeout" },
		{ key: "skip", direction: "output", role: "skip" },
		{ key: "next", direction: "output" },
	];

	it("uses one neutral grey dot treatment for every role", () => {
		for (const port of ROLES) {
			expect(stylesForPort(port).dot).toContain("#98a6bd");
		}
	});

	it("is monochrome — all roles resolve to identical dot + chip styling", () => {
		const styles = ROLES.map((port) => JSON.stringify(stylesForPort(port)));
		expect(new Set(styles).size).toBe(1);
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
		const firstOutput = outputs[0];
		if (!firstOutput) throw new Error("expected at least one output port");
		// Branch ports share the same neutral dot as every other port.
		expect(stylesForPort(firstOutput).dot).toContain("#98a6bd");
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
