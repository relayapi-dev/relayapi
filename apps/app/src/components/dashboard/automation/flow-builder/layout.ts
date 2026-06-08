// layout.ts
//
// Dagre-based auto-layout for the automation canvas. Replaces the hand-rolled
// BFS layout (which spaced nodes by fixed 420/200 steps and overlapped, since
// step cards render 390px wide and can be far taller than 200px). Dagre packs
// nodes by their *actual* dimensions, so the result never overlaps regardless
// of card size or graph shape.
//
// The same dagre graph-building logic is mirrored in the backend template
// builder (`apps/api/src/services/automations/templates/_layout.ts`) so freshly
// created automations are non-overlapping on first paint. Keep the two in sync.

import dagre from "@dagrejs/dagre";

export interface LayoutNode {
	key: string;
	/** Rendered width in canvas units (measured, or a per-kind estimate). */
	width: number;
	/** Rendered height in canvas units (measured, or a per-kind estimate). */
	height: number;
}

export interface LayoutEdge {
	from: string;
	to: string;
}

export interface LayoutPosition {
	/** Top-left x (React Flow node positions are top-left, dagre is centre). */
	x: number;
	y: number;
}

export interface LayoutOptions {
	/** "LR" = left-to-right (default, matches the trigger→action flow). */
	rankdir?: "LR" | "TB" | "RL" | "BT";
	/** Gap between nodes in the same rank (cross-axis). */
	nodesep?: number;
	/** Gap between ranks (main-flow axis). */
	ranksep?: number;
	marginx?: number;
	marginy?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
	rankdir: "LR",
	nodesep: 64,
	ranksep: 160,
	marginx: 40,
	marginy: 40,
};

/**
 * Computes non-overlapping top-left positions for every node.
 *
 * Pure: never mutates inputs. Every node in `nodes` is laid out (including
 * orphans with no edges); edges referencing unknown nodes are ignored.
 */
export function layoutGraph(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	options: LayoutOptions = {},
): Map<string, LayoutPosition> {
	const positions = new Map<string, LayoutPosition>();
	if (nodes.length === 0) return positions;

	const opts = { ...DEFAULTS, ...options };
	const g = new dagre.graphlib.Graph();
	g.setGraph({
		rankdir: opts.rankdir,
		nodesep: opts.nodesep,
		ranksep: opts.ranksep,
		marginx: opts.marginx,
		marginy: opts.marginy,
	});
	g.setDefaultEdgeLabel(() => ({}));

	const known = new Set<string>();
	for (const node of nodes) {
		// Guard against non-finite/zero dims so dagre always has a real box.
		const width = node.width > 0 ? node.width : 1;
		const height = node.height > 0 ? node.height : 1;
		g.setNode(node.key, { width, height });
		known.add(node.key);
	}

	for (const edge of edges) {
		if (known.has(edge.from) && known.has(edge.to)) {
			g.setEdge(edge.from, edge.to);
		}
	}

	dagre.layout(g);

	for (const node of nodes) {
		const laid = g.node(node.key);
		// dagre returns the node centre; React Flow wants the top-left corner.
		positions.set(node.key, {
			x: laid.x - node.width / 2,
			y: laid.y - node.height / 2,
		});
	}

	return positions;
}
