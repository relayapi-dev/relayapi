// apps/api/src/services/automations/templates/_layout.ts
//
// Auto-layout helper for template-built graphs. Template builders produce
// correct graph topology but leave canvas_x / canvas_y unset — every node
// would otherwise stack at (0, 0) on the dashboard canvas. This helper walks
// the graph BFS from root_node_key and assigns positions so nodes render in
// a sensible left-to-right tree.
//
// Layout math:
//   canvas_x = 100 + depth * 420
//   canvas_y = 100 + sibling_index * 200
// where sibling_index is a running counter per depth level (BFS order).
// Orphan nodes (unreachable from the root) are stacked below at depth 0.

import type { Graph, GraphNode } from "../../../schemas/automation-graph";

const X_START = 100;
// Canvas cards render at ~346px wide in the dashboard, so the horizontal step
// must exceed that width or template-built nodes will overlap on first load.
const X_STEP = 420;
const Y_START = 100;
const Y_STEP = 200;

export function autoLayoutGraph(graph: Graph): Graph {
	if (!graph.root_node_key) return graph;

	const adjacency = new Map<string, string[]>();
	for (const e of graph.edges) {
		if (!adjacency.has(e.from_node)) adjacency.set(e.from_node, []);
		adjacency.get(e.from_node)!.push(e.to_node);
	}

	const positions = new Map<string, { x: number; y: number }>();
	const visited = new Set<string>();
	type QueueItem = { key: string; depth: number };
	const queue: QueueItem[] = [{ key: graph.root_node_key, depth: 0 }];
	const depthCounters = new Map<number, number>();

	while (queue.length > 0) {
		const { key, depth } = queue.shift()!;
		if (visited.has(key)) continue;
		visited.add(key);
		const sibling = depthCounters.get(depth) ?? 0;
		depthCounters.set(depth, sibling + 1);
		positions.set(key, {
			x: X_START + depth * X_STEP,
			y: Y_START + sibling * Y_STEP,
		});
		for (const next of adjacency.get(key) ?? []) {
			if (!visited.has(next)) queue.push({ key: next, depth: depth + 1 });
		}
	}

	// Any unreached node (orphan) gets stacked below the reachable subgraph
	// so it remains visible on the canvas rather than piling at (0, 0).
	let orphanRow = 0;
	const updatedNodes: GraphNode[] = graph.nodes.map((n) => {
		if (positions.has(n.key)) {
			const p = positions.get(n.key)!;
			return { ...n, canvas_x: p.x, canvas_y: p.y };
		}
		const orphanY = Y_START + orphanRow++ * Y_STEP + 600;
		return { ...n, canvas_x: X_START, canvas_y: orphanY };
	});

	return { ...graph, nodes: updatedNodes };
}
