// apps/api/src/services/automations/templates/_layout.ts
//
// Auto-layout helper for template-built graphs. Template builders produce
// correct graph topology but leave canvas_x / canvas_y unset — every node
// would otherwise stack at (0, 0) on the dashboard canvas. This helper runs
// dagre over the graph and assigns non-overlapping positions so nodes render
// in a sensible left-to-right tree on first load.
//
// Dagre packs nodes by their actual box size, so positions never overlap
// regardless of card size or branch fan-out (the previous fixed-step BFS
// layout overlapped: step cards render 390px wide but were only spaced 420px
// apart, and tall sibling cards collided on a fixed 200px row gap).
//
// The dashboard mirrors this exact dagre setup in
// `apps/app/src/components/dashboard/automation/flow-builder/layout.ts`
// (which uses *measured* card sizes). The server can't measure the DOM, so it
// estimates each card's size from its kind + derived output ports. Keep the
// two layouts in sync.

import dagre from "@dagrejs/dagre";
import type { Graph, GraphNode } from "../../../schemas/automation-graph";
import { derivePorts } from "../ports";

// Step cards render at `w-[390px]` in the dashboard (guided-flow.tsx).
export const NODE_WIDTH = 390;
// Base card height (header + body + footer). Generous so estimates never come
// in *under* the rendered height, which would let dagre pack cards too tightly.
const BASE_HEIGHT = 200;
// Each interactive output port (quick reply, branch button, condition branch)
// adds a row to the card, making it taller.
const PER_OUTPUT_HEIGHT = 36;

// Dagre spacing — mirrored in the dashboard layout helper.
const RANK_DIR = "LR" as const;
const NODE_SEP = 64; // cross-axis gap between same-rank cards
const RANK_SEP = 160; // main-axis gap between ranks
const MARGIN = 40;

/**
 * Estimates a card's rendered size from its kind + config. Exported so tests
 * can assert the laid-out graph has no overlapping bounding boxes.
 */
export function estimateNodeSize(
	node: Pick<GraphNode, "kind" | "config">,
): { width: number; height: number } {
	const outputs = derivePorts(node).filter(
		(p) => p.direction === "output",
	).length;
	return {
		width: NODE_WIDTH,
		height: BASE_HEIGHT + Math.max(0, outputs - 1) * PER_OUTPUT_HEIGHT,
	};
}

export function autoLayoutGraph(graph: Graph): Graph {
	if (graph.nodes.length === 0) return graph;

	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: RANK_DIR,
		nodesep: NODE_SEP,
		ranksep: RANK_SEP,
		marginx: MARGIN,
		marginy: MARGIN,
	});
	g.setDefaultEdgeLabel(() => ({}));

	const sizes = new Map<string, { width: number; height: number }>();
	const known = new Set<string>();
	for (const node of graph.nodes) {
		const size = estimateNodeSize(node);
		sizes.set(node.key, size);
		g.setNode(node.key, size);
		known.add(node.key);
	}

	for (const e of graph.edges) {
		if (known.has(e.from_node) && known.has(e.to_node)) {
			g.setEdge(e.from_node, e.to_node);
		}
	}

	dagre.layout(g);

	const updatedNodes: GraphNode[] = graph.nodes.map((node) => {
		const laid = g.node(node.key);
		const size = sizes.get(node.key)!;
		// dagre returns the node centre; the canvas stores the top-left corner.
		return {
			...node,
			canvas_x: Math.round(laid.x - size.width / 2),
			canvas_y: Math.round(laid.y - size.height / 2),
		};
	});

	return { ...graph, nodes: updatedNodes };
}
