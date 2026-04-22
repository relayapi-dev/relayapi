// apps/api/src/services/automations/validator.ts
import { applyDerivedPorts } from "./ports";
import type { Graph, GraphNode } from "../../schemas/automation-graph";

export type ValidationIssue = {
  code: string;
  message: string;
  node_key?: string;
  port_key?: string;
  edge_index?: number;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  canonicalGraph: Graph;
};

const ENTRY_KINDS = new Set([
  "message", "action_group", "condition", "http_request", "start_automation", "end",
]);
const LOOP_PAUSE_KINDS = new Set(["input", "delay", "goto"]);

export function validateGraph(graph: Graph): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Regenerate ports (canonical form)
  const canonical: Graph = {
    schema_version: 1,
    root_node_key: graph.root_node_key,
    nodes: graph.nodes.map(applyDerivedPorts),
    edges: graph.edges.slice(),
  };

  // 1. unique node keys
  const seen = new Set<string>();
  for (const n of canonical.nodes) {
    if (seen.has(n.key)) {
      errors.push({ code: "duplicate_node_key", message: `duplicate node key "${n.key}"`, node_key: n.key });
    }
    seen.add(n.key);
  }

  // 2. root node kind
  if (!canonical.root_node_key) {
    if (canonical.nodes.length > 0) {
      errors.push({ code: "missing_root", message: "root_node_key is null but graph has nodes" });
    }
  } else {
    const root = canonical.nodes.find((n) => n.key === canonical.root_node_key);
    if (!root) {
      errors.push({ code: "missing_root", message: `root_node_key "${canonical.root_node_key}" not found` });
    } else if (!ENTRY_KINDS.has(root.kind)) {
      errors.push({
        code: "invalid_root_kind",
        message: `root node kind "${root.kind}" cannot be an entry point`,
        node_key: root.key,
      });
    }
  }

  // 2.5. v1.1-stubbed actions cannot be used yet (spec §B10 fix).
  //
  // `change_main_menu` depends on Meta's `messenger_profile.persistent_menu`
  // sync, which is deferred to v1.1. The runtime handler throws if it ever
  // fires, so we fail the automation at validation time instead — the
  // dashboard catches the error and auto-pauses the flow rather than
  // blowing up on first match.
  const DISABLED_ACTION_TYPES: Record<string, string> = {
    change_main_menu:
      'Action "change_main_menu" requires v1.1 platform sync — not yet available',
  };
  for (const n of canonical.nodes) {
    if (n.kind !== "action_group") continue;
    const actions = Array.isArray((n.config as Record<string, unknown> | null | undefined)?.actions)
      ? ((n.config as { actions: unknown[] }).actions as unknown[])
      : [];
    for (const raw of actions) {
      if (!raw || typeof raw !== "object") continue;
      const action = raw as { type?: unknown };
      if (typeof action.type !== "string") continue;
      const msg = DISABLED_ACTION_TYPES[action.type];
      if (msg) {
        errors.push({
          code: "action_unavailable",
          message: msg,
          node_key: n.key,
        });
      }
    }
  }

  // 3. edge references (node + port existence)
  const nodeByKey = new Map(canonical.nodes.map((n) => [n.key, n]));
  for (let i = 0; i < canonical.edges.length; i++) {
    const e = canonical.edges[i];
    if (!e) continue;
    const from = nodeByKey.get(e.from_node);
    const to = nodeByKey.get(e.to_node);
    if (!from) {
      errors.push({ code: "edge_missing_from_node", message: `edge[${i}] from_node "${e.from_node}" missing`, edge_index: i });
      continue;
    }
    if (!to) {
      errors.push({ code: "edge_missing_to_node", message: `edge[${i}] to_node "${e.to_node}" missing`, edge_index: i });
      continue;
    }
    if (!from.ports.some((p) => p.key === e.from_port && p.direction === "output")) {
      errors.push({
        code: "edge_missing_from_port",
        message: `edge[${i}] from_port "${e.from_port}" does not exist on node "${from.key}"`,
        edge_index: i, node_key: from.key, port_key: e.from_port,
      });
    }
    if (!to.ports.some((p) => p.key === e.to_port && p.direction === "input")) {
      errors.push({
        code: "edge_missing_to_port",
        message: `edge[${i}] to_port "${e.to_port}" does not exist on node "${to.key}"`,
        edge_index: i, node_key: to.key, port_key: e.to_port,
      });
    }
  }

  // 4. orphan nodes (non-root with no incoming edges)
  const incoming = new Set<string>();
  for (const e of canonical.edges) incoming.add(e.to_node);
  for (const n of canonical.nodes) {
    if (n.key === canonical.root_node_key) continue;
    if (!incoming.has(n.key)) {
      errors.push({ code: "orphan_node", message: `node "${n.key}" has no incoming edge`, node_key: n.key });
    }
  }

  // 5. cycle without a pause point
  const cycles = findCycles(canonical);
  for (const cycle of cycles) {
    const hasPause = cycle.some((key) => {
      const n = nodeByKey.get(key);
      return n ? LOOP_PAUSE_KINDS.has(n.kind) : false;
    });
    if (!hasPause) {
      errors.push({
        code: "cycle_without_pause",
        message: `cycle without input/delay/goto pause point: ${cycle.join(" → ")}`,
        node_key: cycle[0],
      });
    }
  }

  // 6. warnings: orphan output ports with no outgoing edge
  const outgoing = new Map<string, Set<string>>();
  for (const e of canonical.edges) {
    if (!outgoing.has(e.from_node)) outgoing.set(e.from_node, new Set());
    outgoing.get(e.from_node)!.add(e.from_port);
  }
  for (const n of canonical.nodes) {
    for (const p of n.ports) {
      if (p.direction !== "output") continue;
      if (!outgoing.get(n.key)?.has(p.key)) {
        warnings.push({
          code: "port_no_outgoing_edge",
          message: `node "${n.key}" port "${p.key}" has no outgoing edge`,
          node_key: n.key, port_key: p.key,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, canonicalGraph: canonical };
}

function findCycles(graph: Graph): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.from_node)) adj.set(e.from_node, []);
    adj.get(e.from_node)!.push(e.to_node);
  }
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=in-stack, 2=done
  const stack: string[] = [];
  const dfs = (u: string) => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const startIdx = stack.indexOf(v);
        if (startIdx >= 0) cycles.push(stack.slice(startIdx));
      } else if (c === 0) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const n of graph.nodes) if ((color.get(n.key) ?? 0) === 0) dfs(n.key);
  return cycles;
}
