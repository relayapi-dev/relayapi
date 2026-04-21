// node-overlays.test.ts — Plan 3 Unit C4, Phase U (Task U1).
//
// Covers the pure helper functions that drive the badge's color, label,
// and per-port popover ordering. The fetching hook itself is exercised
// end-to-end through the canvas integration tests.

import { describe, expect, it } from "bun:test";
import {
	formatSuccessRate,
	rankPorts,
	summarizeMetrics,
	toneForMetrics,
	type NodeMetrics,
} from "./node-overlays-helpers";

function metrics(partial: Partial<NodeMetrics>): NodeMetrics {
	return {
		executions: 0,
		success_rate: 0,
		per_port: {},
		...partial,
	};
}

describe("toneForMetrics", () => {
	it("returns grey when metrics are absent", () => {
		expect(toneForMetrics(undefined)).toBe("grey");
	});

	it("returns grey for zero executions", () => {
		expect(toneForMetrics(metrics({ executions: 0, success_rate: 1 }))).toBe(
			"grey",
		);
	});

	it("returns grey for non-finite success rate", () => {
		expect(
			toneForMetrics(metrics({ executions: 10, success_rate: Number.NaN })),
		).toBe("grey");
	});

	it("returns green for success > 90%", () => {
		expect(
			toneForMetrics(metrics({ executions: 100, success_rate: 0.94 })),
		).toBe("green");
	});

	it("returns yellow at the 70% boundary", () => {
		expect(
			toneForMetrics(metrics({ executions: 10, success_rate: 0.7 })),
		).toBe("yellow");
	});

	it("returns yellow at the upper 90% boundary", () => {
		// rate exactly 0.9 falls into the 70-90 band per spec (> 90% only).
		expect(
			toneForMetrics(metrics({ executions: 10, success_rate: 0.9 })),
		).toBe("yellow");
	});

	it("returns red below 70%", () => {
		expect(
			toneForMetrics(metrics({ executions: 10, success_rate: 0.69 })),
		).toBe("red");
	});
});

describe("rankPorts", () => {
	it("returns an empty list for an empty object", () => {
		expect(rankPorts({})).toEqual([]);
	});

	it("sorts by count descending", () => {
		expect(rankPorts({ a: 1, b: 9, c: 3 })).toEqual([
			{ port: "b", count: 9 },
			{ port: "c", count: 3 },
			{ port: "a", count: 1 },
		]);
	});

	it("breaks ties alphabetically for stable order", () => {
		expect(rankPorts({ zeta: 5, alpha: 5, mu: 5 })).toEqual([
			{ port: "alpha", count: 5 },
			{ port: "mu", count: 5 },
			{ port: "zeta", count: 5 },
		]);
	});
});

describe("formatSuccessRate", () => {
	it("formats a rate as rounded percent", () => {
		expect(formatSuccessRate(0)).toBe("0%");
		expect(formatSuccessRate(0.9456)).toBe("95%");
		expect(formatSuccessRate(1)).toBe("100%");
	});

	it("returns an em-dash for NaN / Infinity", () => {
		expect(formatSuccessRate(Number.NaN)).toBe("—");
		expect(formatSuccessRate(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("summarizeMetrics", () => {
	it("returns a zero-state summary when metrics are absent", () => {
		expect(summarizeMetrics(undefined)).toEqual({
			executionsLabel: "0",
			rateLabel: null,
			topPort: null,
		});
	});

	it("returns a zero-state summary for zero executions", () => {
		expect(
			summarizeMetrics(
				metrics({ executions: 0, success_rate: 0.9, per_port: { next: 0 } }),
			),
		).toEqual({
			executionsLabel: "0",
			rateLabel: null,
			topPort: null,
		});
	});

	it("reports the most-used port", () => {
		const result = summarizeMetrics(
			metrics({
				executions: 312,
				success_rate: 0.94,
				per_port: {
					next: 294,
					"button.btn_large": 18,
				},
			}),
		);
		expect(result.executionsLabel).toBe("312");
		expect(result.rateLabel).toBe("94%");
		expect(result.topPort).toBe("next");
	});

	it("omits the top port when per_port is empty", () => {
		const result = summarizeMetrics(
			metrics({ executions: 5, success_rate: 1, per_port: {} }),
		);
		expect(result.executionsLabel).toBe("5");
		expect(result.rateLabel).toBe("100%");
		expect(result.topPort).toBeNull();
	});
});
