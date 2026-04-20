import type {
	AutomationDetail,
	AutomationSchema,
} from "./types";
import { resolveNodeOutputLabels } from "./output-labels";

export interface ValidationIssue {
	nodeKey?: string;
	message: string;
	severity: "error" | "warning";
}

export function validateGraph(
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

	// Union of allowed output labels across all triggers. For the `trigger`
	// virtual source on the canvas, an edge label is valid if *any* trigger
	// exposes it as an output.
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
				: resolveNodeOutputLabels(
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
		const outputs = resolveNodeOutputLabels(n, def);
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
