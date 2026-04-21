// Client-side graph validator (Plan 2 — Unit B2, Task L3).
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
//
// The `validateLegacyGraph` function below is the pre-rewrite
// `(automation, schema) => ValidationIssue[]` signature, kept around only
// because `automation-detail-page.tsx` is still on the legacy shape. It will
// be deleted as part of Phase P once the detail page is ported to the new
// store-based canvas.

import type {
	AutomationEdge,
	AutomationGraph,
	AutomationNode,
} from "./graph-types";
import { applyDerivedPorts } from "./derive-ports";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "./types";

// ---------------------------------------------------------------------------
// New graph-based validator
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Legacy validator (kept only for the pre-migration detail page).
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `validateGraph(graph)` instead. This function runs against
 * the legacy `AutomationDetail` shape (triggers + untyped node fields +
 * labelled edges) and will be removed when the detail page migrates to the
 * graph-store canvas in Phase P.
 */
export function validateLegacyGraph(
	automation: Pick<AutomationDetail, "triggers" | "nodes" | "edges">,
	schema: AutomationSchema,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (!automation.triggers || automation.triggers.length === 0) {
		issues.push({
			severity: "error",
			message: "Automation must have at least one trigger",
			nodeKey: "trigger",
		});
		return issues;
	}

	const { nodes, edges } = automation;
	const nodeKeys = new Set(nodes.map((n) => n.key));
	nodeKeys.add("trigger");
	const schemaByType = new Map(schema.nodes.map((n) => [n.type, n]));

	for (const trigger of automation.triggers) {
		const triggerDef = schema.triggers.find((s) => s.type === trigger.type);
		if (!triggerDef) {
			issues.push({
				severity: "error",
				message: `Trigger "${trigger.label}" has unknown type "${trigger.type}"`,
				nodeKey: `trigger:${trigger.id}`,
			});
			continue;
		}
		const requiredTriggerFields = extractRequiredFields(triggerDef.config_schema);
		const triggerConfig =
			trigger.config && typeof trigger.config === "object"
				? (trigger.config as Record<string, unknown>)
				: {};
		for (const field of requiredTriggerFields) {
			const value = triggerConfig[field];
			if (value === undefined || value === null || value === "") {
				issues.push({
					severity: "error",
					message: `Trigger "${trigger.label}" is missing required field "${field}"`,
					nodeKey: `trigger:${trigger.id}`,
				});
			}
		}
		if (
			trigger.type !== "manual" &&
			trigger.type !== "external_api" &&
			!trigger.account_id
		) {
			issues.push({
				severity: "error",
				message: `Trigger "${trigger.label}" is missing a bound account`,
				nodeKey: `trigger:${trigger.id}`,
			});
		}
	}

	const triggerOutputLabels = new Set<string>();
	for (const trigger of automation.triggers) {
		const def = schema.triggers.find((s) => s.type === trigger.type);
		const labels = def?.output_labels ?? ["next"];
		for (const label of labels) triggerOutputLabels.add(label);
	}
	if (triggerOutputLabels.size === 0) triggerOutputLabels.add("next");

	for (const e of edges) {
		if (!nodeKeys.has(e.from)) {
			issues.push({
				message: `Edge references unknown source "${e.from}"`,
				severity: "error",
			});
		}
		if (!nodeKeys.has(e.to)) {
			issues.push({
				message: `Edge references unknown target "${e.to}"`,
				severity: "error",
			});
		}
		const sourceNode = nodes.find((n) => n.key === e.from);
		const allowedLabels =
			e.from === "trigger"
				? Array.from(triggerOutputLabels)
				: resolveLegacyNodeOutputLabels(
						sourceNode,
						sourceNode ? schemaByType.get(sourceNode.type) ?? null : null,
					);
		const edgeLabel = e.label ?? "next";
		if (!allowedLabels.includes(edgeLabel)) {
			issues.push({
				nodeKey: e.from,
				message: `Edge from "${e.from}" uses unsupported label "${edgeLabel}"`,
				severity: "error",
			});
		}
	}

	const reachable = new Set<string>(["trigger"]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const e of edges) {
			if (reachable.has(e.from) && !reachable.has(e.to)) {
				reachable.add(e.to);
				changed = true;
			}
		}
	}
	for (const n of nodes) {
		if (!reachable.has(n.key)) {
			issues.push({
				nodeKey: n.key,
				message: `Node "${n.key}" is not reachable from the trigger`,
				severity: "warning",
			});
		}
	}

	for (const n of nodes) {
		const def = schemaByType.get(n.type);
		if (!def) {
			issues.push({
				nodeKey: n.key,
				message: `Unknown node type "${n.type}"`,
				severity: "error",
			});
			continue;
		}
		const required = extractRequiredFields(def.fields_schema);
		for (const field of required) {
			const value = (n as Record<string, unknown>)[field];
			if (value === undefined || value === null || value === "") {
				issues.push({
					nodeKey: n.key,
					message: `"${n.key}" is missing required field "${field}"`,
					severity: "error",
				});
			}
		}
		const outputs = resolveLegacyNodeOutputLabels(n, def);
		if (outputs.length > 1) {
			const outgoing = new Set(
				edges
					.filter((edge) => edge.from === n.key)
					.map((edge) => edge.label ?? "next"),
			);
			for (const label of outputs) {
				if (!outgoing.has(label)) {
					issues.push({
						nodeKey: n.key,
						message: `"${n.key}" has no outgoing path for "${label}"`,
						severity: "warning",
					});
				}
			}
		}
	}

	return issues;
}

function extractRequiredFields(fieldsSchema: unknown): string[] {
	if (!fieldsSchema || typeof fieldsSchema !== "object") return [];
	const schema = fieldsSchema as {
		required?: unknown;
		properties?: Record<string, { default?: unknown }> | unknown;
	};
	if (Array.isArray(schema.required)) {
		const properties =
			schema.properties && typeof schema.properties === "object"
				? (schema.properties as Record<string, { default?: unknown }>)
				: {};
		return schema.required.filter((v): v is string => {
			if (typeof v !== "string") return false;
			return properties[v]?.default === undefined;
		});
	}
	return [];
}

// ---------------------------------------------------------------------------
// Legacy output-label resolution (pre-graph-store nodes).
//
// Kept inline here so `output-labels.ts` can be deleted now that the new
// builder derives labels from `node.ports` (via `derive-ports.ts`). The
// only remaining callers are this legacy validator and `simulator-panel`,
// both of which still operate on the pre-rewrite `AutomationNodeSpec`.
// ---------------------------------------------------------------------------

function legacyLabelsFromEntries(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const labels = value
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const r = entry as Record<string, unknown>;
			const candidates = [
				r.callback_data,
				r.id,
				r.label,
				r.payload,
				r.title,
				r.value,
			];
			for (const c of candidates) {
				if (typeof c === "string" && c.trim()) return c;
			}
			return null;
		})
		.filter((label): label is string => !!label);
	return labels.length > 0 ? labels : fallback;
}

function legacyInteractiveLabels(
	choices: unknown,
	includeTimeout: boolean,
): string[] {
	const labels = legacyLabelsFromEntries(choices, []);
	const extras = ["no_match", ...(includeTimeout ? ["timeout"] : [])];
	return labels.length > 0 ? [...labels, ...extras] : ["next"];
}

/** @internal legacy-only helper used by `validateLegacyGraph`. */
export function resolveLegacyNodeOutputLabels(
	node: AutomationNodeSpec | null | undefined,
	def: SchemaNodeDef | null | undefined,
): string[] {
	if (!node) return def?.output_labels ?? ["next"];
	if (node.type === "randomizer") {
		return legacyLabelsFromEntries(
			node.branches,
			def?.output_labels ?? ["branch_1", "branch_2"],
		);
	}
	if (node.type === "split_test") {
		return legacyLabelsFromEntries(
			node.variants,
			def?.output_labels ?? ["variant_a", "variant_b"],
		);
	}
	if (node.type === "ai_intent_router") {
		return legacyLabelsFromEntries(
			node.intents,
			def?.output_labels ?? ["intent_1", "intent_2"],
		);
	}
	if (
		node.type === "instagram_send_quick_replies" ||
		node.type === "facebook_send_quick_replies"
	) {
		return legacyInteractiveLabels(
			node.quick_replies,
			typeof node.timeout_minutes === "number",
		);
	}
	if (
		node.type === "instagram_send_buttons" ||
		node.type === "facebook_send_button_template"
	) {
		const postbackButtons = Array.isArray(node.buttons)
			? node.buttons.filter(
					(button) =>
						button &&
						typeof button === "object" &&
						(button as { type?: unknown }).type === "postback",
				)
			: [];
		return legacyInteractiveLabels(
			postbackButtons,
			typeof node.timeout_minutes === "number",
		);
	}
	if (node.type === "whatsapp_send_interactive") {
		const labels = legacyLabelsFromWhatsAppInteractive(node, []);
		return legacyInteractiveLabels(
			labels.map((label) => ({ id: label })),
			typeof node.timeout_minutes === "number",
		);
	}
	if (node.type === "telegram_send_keyboard") {
		const rows = Array.isArray(node.buttons)
			? (node.buttons as unknown[]).flatMap((row) =>
					Array.isArray(row) ? row : [],
				)
			: [];
		return legacyInteractiveLabels(
			legacyLabelsFromEntries(rows, []).map((label) => ({
				callback_data: label,
			})),
			typeof node.timeout_minutes === "number",
		);
	}
	return def?.output_labels ?? ["next"];
}

function legacyLabelsFromWhatsAppInteractive(
	node: AutomationNodeSpec,
	fallback: string[],
): string[] {
	if (Array.isArray(node.buttons) && node.buttons.length > 0) {
		return legacyLabelsFromEntries(node.buttons, fallback);
	}
	const list = node.list;
	if (!list || typeof list !== "object") return fallback;
	const sections = Array.isArray((list as { sections?: unknown[] }).sections)
		? (list as { sections: unknown[] }).sections
		: [];
	const rows = sections.flatMap((section) => {
		if (!section || typeof section !== "object") return [];
		const candidate = (section as { rows?: unknown[] }).rows;
		return Array.isArray(candidate) ? candidate : [];
	});
	return legacyLabelsFromEntries(rows, fallback);
}
