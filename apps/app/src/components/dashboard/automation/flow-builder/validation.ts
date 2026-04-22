// Client-side graph validator.
//
// Mirrors `apps/api/src/services/automations/validator.ts` so the dashboard
// can surface validation issues without a round-trip on every edit. Server
// validation is still the source of truth on save; this one just powers the
// in-canvas red-highlight / tooltip UX.
//
// Rules (matching the server):
//   1. No duplicate node keys.
//   2. `root_node_key` must exist on the graph and reference an entry-capable
//      kind (message / action_group / condition / http_request /
//      start_automation / end).
//   3. Every edge references existing `(node, port)` pairs on both ends; the
//      port direction must match (output on the from side, input on the to
//      side).
//   4. Non-root nodes must have at least one incoming edge.
//   5. No cycles — unless the cycle contains an `input`, `delay`, or `goto`
//      node that naturally pauses the run.
//   6. Warnings: output ports that exist but have no outgoing edge.
//
// Ports are derived client-side via `derive-ports.ts` so the rules operate on
// the same canonical port set the server will produce on save.

import type {
	AutomationEdge,
	AutomationGraph,
	AutomationNode,
} from "./graph-types";
import { applyDerivedPorts } from "./derive-ports";

export interface ValidationIssue {
	/** Machine code — `duplicate_node_key`, `orphan_node`, etc. */
	code?: string;
	/** Human-readable, one line, no trailing period. */
	message: string;
	/** `"error"` blocks save (will reject on API too); `"warning"` is advisory. */
	severity: "error" | "warning";
	nodeKey?: string;
	portKey?: string;
	edgeIndex?: number;
}

export interface GraphValidationResult {
	valid: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

const ENTRY_KINDS = new Set([
	"message",
	"action_group",
	"condition",
	"http_request",
	"start_automation",
	"end",
]);

const LOOP_PAUSE_KINDS = new Set(["input", "delay", "goto"]);

export function validateGraph(graph: AutomationGraph): GraphValidationResult {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];

	// Canonicalise ports before running the rest of the checks so we match
	// exactly what the server will store on save.
	const canonicalNodes = graph.nodes.map(applyDerivedPorts);

	// 1. Unique node keys.
	const seen = new Set<string>();
	for (const n of canonicalNodes) {
		if (seen.has(n.key)) {
			errors.push({
				code: "duplicate_node_key",
				message: `duplicate node key "${n.key}"`,
				severity: "error",
				nodeKey: n.key,
			});
		}
		seen.add(n.key);
	}

	// 2. Root node kind.
	if (!graph.root_node_key) {
		if (canonicalNodes.length > 0) {
			errors.push({
				code: "missing_root",
				message: "root_node_key is null but graph has nodes",
				severity: "error",
			});
		}
	} else {
		const root = canonicalNodes.find((n) => n.key === graph.root_node_key);
		if (!root) {
			errors.push({
				code: "missing_root",
				message: `root_node_key "${graph.root_node_key}" not found`,
				severity: "error",
			});
		} else if (!ENTRY_KINDS.has(root.kind)) {
			errors.push({
				code: "invalid_root_kind",
				message: `root node kind "${root.kind}" cannot be an entry point`,
				severity: "error",
				nodeKey: root.key,
			});
		}
	}

	// 3. Edge references.
	const nodeByKey = new Map(canonicalNodes.map((n) => [n.key, n]));
	for (let i = 0; i < graph.edges.length; i++) {
		const e = graph.edges[i];
		if (!e) continue;
		const from = nodeByKey.get(e.from_node);
		const to = nodeByKey.get(e.to_node);
		if (!from) {
			errors.push({
				code: "edge_missing_from_node",
				message: `edge[${i}] from_node "${e.from_node}" missing`,
				severity: "error",
				edgeIndex: i,
			});
			continue;
		}
		if (!to) {
			errors.push({
				code: "edge_missing_to_node",
				message: `edge[${i}] to_node "${e.to_node}" missing`,
				severity: "error",
				edgeIndex: i,
			});
			continue;
		}
		if (
			!from.ports.some(
				(p) => p.key === e.from_port && p.direction === "output",
			)
		) {
			errors.push({
				code: "edge_missing_from_port",
				message: `edge[${i}] from_port "${e.from_port}" does not exist on node "${from.key}"`,
				severity: "error",
				edgeIndex: i,
				nodeKey: from.key,
				portKey: e.from_port,
			});
		}
		if (!to.ports.some((p) => p.key === e.to_port && p.direction === "input")) {
			errors.push({
				code: "edge_missing_to_port",
				message: `edge[${i}] to_port "${e.to_port}" does not exist on node "${to.key}"`,
				severity: "error",
				edgeIndex: i,
				nodeKey: to.key,
				portKey: e.to_port,
			});
		}
	}

	// 4. Orphan nodes.
	const incoming = new Set<string>();
	for (const e of graph.edges) incoming.add(e.to_node);
	for (const n of canonicalNodes) {
		if (n.key === graph.root_node_key) continue;
		if (!incoming.has(n.key)) {
			errors.push({
				code: "orphan_node",
				message: `node "${n.key}" has no incoming edge`,
				severity: "error",
				nodeKey: n.key,
			});
		}
	}

	// 5. Cycle detection.
	const cycles = findCycles(canonicalNodes, graph.edges);
	for (const cycle of cycles) {
		const hasPause = cycle.some((key) => {
			const n = nodeByKey.get(key);
			return n ? LOOP_PAUSE_KINDS.has(n.kind) : false;
		});
		if (!hasPause) {
			errors.push({
				code: "cycle_without_pause",
				message: `cycle without input/delay/goto pause point: ${cycle.join(" → ")}`,
				severity: "error",
				nodeKey: cycle[0],
			});
		}
	}

	// 6. Warnings: output ports with no outgoing edge.
	const outgoing = new Map<string, Set<string>>();
	for (const e of graph.edges) {
		if (!outgoing.has(e.from_node)) outgoing.set(e.from_node, new Set());
		outgoing.get(e.from_node)!.add(e.from_port);
	}
	for (const n of canonicalNodes) {
		for (const p of n.ports) {
			if (p.direction !== "output") continue;
			if (!outgoing.get(n.key)?.has(p.key)) {
				warnings.push({
					code: "port_no_outgoing_edge",
					message: `node "${n.key}" port "${p.key}" has no outgoing edge`,
					severity: "warning",
					nodeKey: n.key,
					portKey: p.key,
				});
			}
		}
	}

	return { valid: errors.length === 0, errors, warnings };
}

function findCycles(nodes: AutomationNode[], edges: AutomationEdge[]): string[][] {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (!adj.has(e.from_node)) adj.set(e.from_node, []);
		adj.get(e.from_node)!.push(e.to_node);
	}
	const cycles: string[][] = [];
	const color = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];
	const dfs = (u: string) => {
		color.set(u, 1);
		stack.push(u);
		for (const v of adj.get(u) ?? []) {
			const c = color.get(v) ?? 0;
			if (c === 1) {
				const startIdx = stack.indexOf(v);
				if (startIdx >= 0) cycles.push(stack.slice(startIdx));
			} else if (c === 0) {
				dfs(v);
			}
		}
		stack.pop();
		color.set(u, 2);
	};
	for (const n of nodes) if ((color.get(n.key) ?? 0) === 0) dfs(n.key);
	return cycles;
}
