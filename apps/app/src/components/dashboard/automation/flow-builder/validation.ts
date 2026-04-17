import type { AutomationNodeSpec, AutomationEdgeSpec } from "./types";
import type { SchemaNodeDef } from "./types";

export interface ValidationIssue {
	nodeKey?: string;
	message: string;
	severity: "error" | "warning";
}

export function validateGraph(
	nodes: AutomationNodeSpec[],
	edges: AutomationEdgeSpec[],
	schemaNodes: SchemaNodeDef[],
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const nodeKeys = new Set(nodes.map((n) => n.key));
	nodeKeys.add("trigger");

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

	const schemaByType = new Map(schemaNodes.map((n) => [n.type, n]));
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
	}

	return issues;
}

function extractRequiredFields(fieldsSchema: unknown): string[] {
	if (!fieldsSchema || typeof fieldsSchema !== "object") return [];
	const schema = fieldsSchema as { required?: unknown; properties?: unknown };
	if (Array.isArray(schema.required)) {
		return schema.required.filter((v): v is string => typeof v === "string");
	}
	return [];
}
