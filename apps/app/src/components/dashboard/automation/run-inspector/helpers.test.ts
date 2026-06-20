// Helpers test (Plan 3 — Unit C2, Phase S).

import { describe, expect, it } from "bun:test";
import {
	entrypointSummary,
	formatDuration,
	nodeKindIcon,
	outcomeAccent,
	outcomeIcon,
	statusColor,
} from "./helpers";

describe("formatDuration", () => {
	it("returns an em-dash for non-finite / negative input", () => {
		expect(formatDuration(Number.NaN)).toBe("—");
		expect(formatDuration(-5)).toBe("—");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
	});

	it("formats sub-second durations with ms suffix", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(450)).toBe("450ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("formats durations under 10s with one decimal", () => {
		expect(formatDuration(1200)).toBe("1.2s");
		expect(formatDuration(5000)).toBe("5.0s");
		expect(formatDuration(9500)).toBe("9.5s");
	});

	it("formats 10s-59s as whole seconds", () => {
		expect(formatDuration(10_000)).toBe("10s");
		expect(formatDuration(59_000)).toBe("59s");
	});

	it("formats minute-plus durations as \"Xm Ys\"", () => {
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(83_000)).toBe("1m 23s");
		expect(formatDuration(125_000)).toBe("2m 5s");
	});

	it("formats hour-plus durations as \"Xh Ym\"", () => {
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(3_660_000)).toBe("1h 1m");
		expect(formatDuration(2 * 3_600_000 + 30 * 60_000)).toBe("2h 30m");
	});
});

describe("statusColor", () => {
	// Monochrome by design — the status word carries the meaning. Red is the
	// only retained hue so genuine failures still read as an alarm; every other
	// status (known or not) shares one neutral pill.
	it("uses a destructive pill for failure", () => {
		expect(statusColor("failed")).toContain("destructive");
	});

	it("uses one neutral pill for every non-failure status", () => {
		const neutral = [
			statusColor("completed"),
			statusColor("active"),
			statusColor("waiting"),
			statusColor("exited"),
			statusColor("weird"),
			statusColor(""),
		];

		// All non-failure statuses collapse to the same neutral pill...
		expect(new Set(neutral).size).toBe(1);
		// ...and none borrow the destructive (failure) hue.
		for (const cls of neutral) {
			expect(cls).not.toContain("destructive");
		}
	});
});

describe("outcomeIcon", () => {
	it("returns check-circle-2 for success-ish outcomes", () => {
		expect(outcomeIcon("advance")).toBe("check-circle-2");
		expect(outcomeIcon("success")).toBe("check-circle-2");
	});

	it("returns clock for waiting outcomes", () => {
		expect(outcomeIcon("waiting")).toBe("clock");
		expect(outcomeIcon("wait_input")).toBe("clock");
		expect(outcomeIcon("wait_delay")).toBe("clock");
	});

	it("returns x-circle for failures", () => {
		expect(outcomeIcon("failed")).toBe("x-circle");
		expect(outcomeIcon("error")).toBe("x-circle");
		expect(outcomeIcon("fail")).toBe("x-circle");
	});

	it("returns minus-circle for skipped", () => {
		expect(outcomeIcon("skipped")).toBe("minus-circle");
	});

	it("returns stop-circle for end", () => {
		expect(outcomeIcon("end")).toBe("stop-circle");
	});

	it("falls back to circle for unknown outcomes", () => {
		expect(outcomeIcon("mystery")).toBe("circle");
	});
});

describe("outcomeAccent", () => {
	// Monochrome by design — only failure keeps a hue (destructive). Success,
	// waiting, and skipped share neutral greys so the timeline stays calm.
	it("uses one neutral accent for success-ish and waiting outcomes", () => {
		const neutral = [
			outcomeAccent("advance"),
			outcomeAccent("success"),
			outcomeAccent("end"),
			outcomeAccent("waiting"),
			outcomeAccent("wait_input"),
			outcomeAccent("wait_delay"),
		];
		// They all collapse to the same neutral accent...
		expect(new Set(neutral).size).toBe(1);
		// ...with no leftover semantic hue.
		for (const cls of neutral) {
			expect(cls).not.toContain("destructive");
			expect(cls).not.toContain("emerald");
			expect(cls).not.toContain("amber");
		}
	});
	it("uses its own muted grey for skipped", () => {
		const skipped = outcomeAccent("skipped");
		expect(skipped).not.toContain("destructive");
		expect(skipped).not.toContain("emerald");
		// distinct (lighter) from the standard success/waiting neutral accent
		expect(skipped).not.toBe(outcomeAccent("success"));
	});
	it("returns a destructive accent for failure", () => {
		expect(outcomeAccent("failed")).toContain("destructive");
		expect(outcomeAccent("error")).toContain("destructive");
	});
	it("returns a neutral border accent for unknown outcomes", () => {
		expect(outcomeAccent("huh")).toContain("border-border");
	});
});

describe("nodeKindIcon", () => {
	it("maps known node kinds to lucide identifiers", () => {
		expect(nodeKindIcon("message")).toBe("message-square");
		expect(nodeKindIcon("condition")).toBe("git-branch");
		expect(nodeKindIcon("delay")).toBe("clock");
		expect(nodeKindIcon("action_group")).toBe("zap");
		expect(nodeKindIcon("end")).toBe("stop-circle");
		expect(nodeKindIcon("goto")).toBe("corner-down-right");
		expect(nodeKindIcon("start_automation")).toBe("corner-down-right");
		expect(nodeKindIcon("http_request")).toBe("globe");
		expect(nodeKindIcon("randomizer")).toBe("shuffle");
		expect(nodeKindIcon("input")).toBe("play");
	});

	it("falls back to \"bot\" for unknown kinds", () => {
		expect(nodeKindIcon("something-else")).toBe("bot");
		expect(nodeKindIcon("")).toBe("bot");
	});
});

describe("entrypointSummary", () => {
	it("returns \"Manual enrollment\" when there is no entrypoint id", () => {
		expect(entrypointSummary({ entrypoint_id: null })).toBe(
			"Manual enrollment",
		);
	});

	it("prefers an explicit label when one is provided", () => {
		expect(
			entrypointSummary({
				entrypoint_id: "ep_1",
				entrypoint_label: "Sign up webhook",
				entrypoint_kind: "webhook",
			}),
		).toBe("Sign up webhook");
	});

	it("falls back to the kind when no label is supplied", () => {
		expect(
			entrypointSummary({
				entrypoint_id: "ep_1",
				entrypoint_kind: "message_keyword",
			}),
		).toBe("Entrypoint: message_keyword");
	});

	it("falls back to a generic phrase when only the id is known", () => {
		expect(entrypointSummary({ entrypoint_id: "ep_1" })).toBe(
			"Automation entrypoint",
		);
	});
});
