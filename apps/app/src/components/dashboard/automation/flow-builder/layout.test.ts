// layout.test.ts
//
// The dagre-based auto-layout must guarantee that no two node bounding boxes
// overlap, regardless of graph shape (chain, sibling branches, tall cards,
// disconnected orphans). These tests assert that invariant directly rather
// than pinning exact coordinates, so the layout engine can evolve freely.

import { describe, expect, it } from "bun:test";
import { type LayoutEdge, type LayoutNode, layoutGraph } from "./layout";

const W = 390;
const H = 180;

function n(key: string, width = W, height = H): LayoutNode {
	return { key, width, height };
}

function boxesOverlap(
	a: { x: number; y: number; w: number; h: number },
	b: { x: number; y: number; w: number; h: number },
): boolean {
	// Strict overlap: touching edges (a.x + a.w === b.x) do NOT count.
	return (
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
	);
}

function assertNoOverlap(
	nodes: LayoutNode[],
	positions: Map<string, { x: number; y: number }>,
): void {
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const a = nodes[i];
			const b = nodes[j];
			if (!a || !b) throw new Error("expected nodes to be defined");
			const pa = positions.get(a.key);
			const pb = positions.get(b.key);
			if (!pa || !pb) throw new Error("expected positions for every node");
			const boxA = { x: pa.x, y: pa.y, w: a.width, h: a.height };
			const boxB = { x: pb.x, y: pb.y, w: b.width, h: b.height };
			expect({
				pair: `${a.key}/${b.key}`,
				overlap: boxesOverlap(boxA, boxB),
			}).toEqual({ pair: `${a.key}/${b.key}`, overlap: false });
		}
	}
}

function requirePos(
	positions: Map<string, { x: number; y: number }>,
	key: string,
): { x: number; y: number } {
	const p = positions.get(key);
	if (!p) throw new Error(`expected a position for "${key}"`);
	return p;
}

describe("layoutGraph", () => {
	it("returns an empty map for no nodes", () => {
		expect(layoutGraph([], []).size).toBe(0);
	});

	it("assigns a position to every node", () => {
		const nodes = [n("a"), n("b"), n("c")];
		const edges: LayoutEdge[] = [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		];
		const pos = layoutGraph(nodes, edges);
		for (const node of nodes) {
			const p = pos.get(node.key);
			expect(p).toBeDefined();
			if (!p) throw new Error("expected a position for the node");
			expect(Number.isFinite(p.x)).toBe(true);
			expect(Number.isFinite(p.y)).toBe(true);
		}
	});

	it("lays out a linear chain left-to-right without overlap", () => {
		const nodes = [n("a"), n("b"), n("c")];
		const edges: LayoutEdge[] = [
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		];
		const pos = layoutGraph(nodes, edges);
		assertNoOverlap(nodes, pos);
		// Left-to-right: each downstream node sits strictly right of its parent.
		expect(requirePos(pos, "a").x).toBeLessThan(requirePos(pos, "b").x);
		expect(requirePos(pos, "b").x).toBeLessThan(requirePos(pos, "c").x);
	});

	it("separates sibling branches so they do not overlap", () => {
		const nodes = [n("root"), n("a"), n("b")];
		const edges: LayoutEdge[] = [
			{ from: "root", to: "a" },
			{ from: "root", to: "b" },
		];
		const pos = layoutGraph(nodes, edges);
		assertNoOverlap(nodes, pos);
		// Root sits left of both children.
		expect(requirePos(pos, "root").x).toBeLessThan(requirePos(pos, "a").x);
		expect(requirePos(pos, "root").x).toBeLessThan(requirePos(pos, "b").x);
	});

	it("keeps tall sibling cards from overlapping vertically", () => {
		const nodes = [n("root"), n("a", W, 420), n("b", W, 420)];
		const edges: LayoutEdge[] = [
			{ from: "root", to: "a" },
			{ from: "root", to: "b" },
		];
		const pos = layoutGraph(nodes, edges);
		assertNoOverlap(nodes, pos);
	});

	it("positions disconnected orphan nodes without overlap", () => {
		const nodes = [n("a"), n("b"), n("orphan")];
		const edges: LayoutEdge[] = [{ from: "a", to: "b" }];
		const pos = layoutGraph(nodes, edges);
		expect(pos.get("orphan")).toBeDefined();
		assertNoOverlap(nodes, pos);
	});
});
