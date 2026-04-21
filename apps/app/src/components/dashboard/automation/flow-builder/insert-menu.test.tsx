// Insert menu tests (Plan 2 — Unit B2, Task L4).
//
// As with `port-handles.test.tsx`, React Testing Library isn't installed in
// apps/app yet, so we can only cover the pure helpers (filtering and the
// recent-kinds localStorage hop) rather than driving the full popover. When
// RTL lands, add a render test that covers keyboard nav (ArrowDown, Enter)
// end-to-end.

import { describe, expect, it } from "bun:test";
import { filterKinds } from "./insert-menu";
import type { CatalogNodeKind } from "./use-catalog";

const catalog: CatalogNodeKind[] = [
	{
		kind: "message",
		label: "Message",
		category: "content",
		description: "Send a rich message with buttons",
	},
	{
		kind: "condition",
		label: "Condition",
		category: "logic",
		description: "Branch based on a filter expression",
	},
	{
		kind: "action_group",
		label: "Action group",
		category: "actions",
		description: "Tag contacts, set fields, run webhooks",
	},
	{
		kind: "end",
		label: "End",
		category: "flow",
		description: "Stop the run",
	},
];

describe("filterKinds", () => {
	it("returns all kinds when the query is empty", () => {
		expect(filterKinds(catalog, "")).toHaveLength(catalog.length);
		expect(filterKinds(catalog, "   ")).toHaveLength(catalog.length);
	});

	it("matches against label", () => {
		const matches = filterKinds(catalog, "condition");
		expect(matches.map((k) => k.kind)).toEqual(["condition"]);
	});

	it("matches against description (case-insensitive)", () => {
		const matches = filterKinds(catalog, "WEBHOOK");
		expect(matches.map((k) => k.kind)).toEqual(["action_group"]);
	});

	it("matches against category", () => {
		const matches = filterKinds(catalog, "flow");
		expect(matches.map((k) => k.kind)).toEqual(["end"]);
	});

	it("matches against kind name", () => {
		const matches = filterKinds(catalog, "action_g");
		expect(matches.map((k) => k.kind)).toEqual(["action_group"]);
	});

	it("returns empty when no match", () => {
		expect(filterKinds(catalog, "does-not-exist")).toEqual([]);
	});
});
