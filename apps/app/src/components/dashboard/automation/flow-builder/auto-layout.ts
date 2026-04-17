import dagre from "dagre";
import type { Edge, Node } from "@xyflow/react";

const NODE_WIDTH = 260;
const NODE_HEIGHT = 110;

export function autoLayout(nodes: Node[], edges: Edge[]): Node[] {
	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 60 });

	for (const n of nodes) {
		g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const e of edges) {
		g.setEdge(e.source, e.target);
	}

	dagre.layout(g);

	return nodes.map((n) => {
		const pos = g.node(n.id);
		if (!pos) return n;
		return {
			...n,
			position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
		};
	});
}

export function needsAutoLayout(nodes: Node[]): boolean {
	return nodes.every((n) => n.position.x === 0 && n.position.y === 0);
}
