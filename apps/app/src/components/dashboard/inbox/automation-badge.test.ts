// automation-badge.test.ts — Plan 3 Unit C4, Phase V (Task V1).
//
// Unit tests for the helpers that back the inbox automation badge.
// The component itself is exercised through the integration smoke
// tests; these cover the pure functions that compute its labels and
// pick the run to surface.

import { describe, expect, it } from "bun:test";
import {
	formatStepLabel,
	formatStepPosition,
	pickPrimaryRun,
} from "./automation-badge-helpers";

const NODES = [
	{ key: "welcome", kind: "message", title: "Welcome" },
	{ key: "ask_email", kind: "input", title: "Ask email" },
	{ key: "end", kind: "end", title: null },
];

describe("formatStepLabel", () => {
	it("returns 'active' when the run has no current node and is active", () => {
		expect(
			formatStepLabel({ current_node_key: null, status: "active" }, NODES),
		).toBe("active");
	});

	it("returns 'waiting' when the run has no current node and is waiting", () => {
		expect(
			formatStepLabel({ current_node_key: null, status: "waiting" }, NODES),
		).toBe("waiting");
	});

	it("returns the node title when available", () => {
		expect(
			formatStepLabel(
				{ current_node_key: "welcome", status: "active" },
				NODES,
			),
		).toBe("Welcome");
	});

	it("falls back to the node kind when the title is missing", () => {
		expect(
			formatStepLabel({ current_node_key: "end", status: "active" }, NODES),
		).toBe("end");
	});

	it("falls back to the raw key when the graph is unknown", () => {
		expect(
			formatStepLabel(
				{ current_node_key: "mystery", status: "active" },
				undefined,
			),
		).toBe("mystery");
	});

	it("falls back to the raw key when the node isn't in the graph", () => {
		expect(
			formatStepLabel(
				{ current_node_key: "not_a_node", status: "active" },
				NODES,
			),
		).toBe("not_a_node");
	});
});

describe("formatStepPosition", () => {
	it("returns null when the graph isn't loaded yet", () => {
		expect(formatStepPosition("welcome", undefined)).toBeNull();
	});

	it("returns null for an empty graph", () => {
		expect(formatStepPosition("welcome", [])).toBeNull();
	});

	it("returns null for a missing current node", () => {
		expect(formatStepPosition(null, NODES)).toBeNull();
		expect(formatStepPosition(undefined, NODES)).toBeNull();
	});

	it("returns a 1-indexed position for a known node", () => {
		expect(formatStepPosition("welcome", NODES)).toEqual({
			index: 1,
			total: 3,
		});
		expect(formatStepPosition("ask_email", NODES)).toEqual({
			index: 2,
			total: 3,
		});
		expect(formatStepPosition("end", NODES)).toEqual({ index: 3, total: 3 });
	});

	it("returns null when the node key isn't in the graph", () => {
		expect(formatStepPosition("unknown", NODES)).toBeNull();
	});
});

describe("pickPrimaryRun", () => {
	const automations = [
		{ id: "a_1", name: "Welcome flow", channel: "instagram", status: "active" },
		{ id: "a_2", name: "Winback", channel: "instagram", status: "active" },
	];

	it("returns null when there are no runs", () => {
		expect(pickPrimaryRun([], automations)).toBeNull();
	});

	it("returns null when runs exist but their automations are missing", () => {
		const runs = [
			{
				id: "r_1",
				automation_id: "missing",
				contact_id: "c_1",
				status: "active",
				current_node_key: null,
				current_port_key: null,
				started_at: "2026-04-01T00:00:00Z",
			},
		];
		expect(pickPrimaryRun(runs, automations)).toBeNull();
	});

	it("prefers active over waiting", () => {
		const runs = [
			{
				id: "r_wait",
				automation_id: "a_1",
				contact_id: "c_1",
				status: "waiting",
				current_node_key: null,
				current_port_key: null,
				started_at: "2026-04-10T00:00:00Z",
			},
			{
				id: "r_active",
				automation_id: "a_2",
				contact_id: "c_1",
				status: "active",
				current_node_key: null,
				current_port_key: null,
				started_at: "2026-04-02T00:00:00Z",
			},
		];
		const result = pickPrimaryRun(runs, automations);
		expect(result?.run.id).toBe("r_active");
		expect(result?.automation.id).toBe("a_2");
	});

	it("breaks ties by most recent start", () => {
		const runs = [
			{
				id: "r_old",
				automation_id: "a_1",
				contact_id: "c_1",
				status: "active",
				current_node_key: null,
				current_port_key: null,
				started_at: "2026-04-01T00:00:00Z",
			},
			{
				id: "r_new",
				automation_id: "a_2",
				contact_id: "c_1",
				status: "active",
				current_node_key: null,
				current_port_key: null,
				started_at: "2026-04-15T00:00:00Z",
			},
		];
		const result = pickPrimaryRun(runs, automations);
		expect(result?.run.id).toBe("r_new");
	});
});
