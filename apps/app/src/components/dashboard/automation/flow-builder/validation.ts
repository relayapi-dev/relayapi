import type {
	AutomationDetail,
	AutomationEdgeSpec,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "./types";
import { resolveNodeOutputLabels } from "./output-labels";

export interface ValidationIssue {
	nodeKey?: string;
	message: string;
	severity: "error" | "warning";
}

export function validateGraph(
	automation: Pick<
		AutomationDetail,
		"trigger_type" | "trigger_config" | "social_account_id" | "nodes" | "edges"
	>,
	schema: AutomationSchema,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const { nodes, edges } = automation;
	const nodeKeys = new Set(nodes.map((n) => n.key));
	nodeKeys.add("trigger");
	const schemaByType = new Map(schema.nodes.map((n) => [n.type, n]));
	const triggerDef = schema.triggers.find((trigger) => trigger.type === automation.trigger_type);

	if (!triggerDef) {
		issues.push({
			nodeKey: "trigger",
			message: `Unknown trigger type "${automation.trigger_type}"`,
			severity: "error",
		});
	} else {
		const requiredTriggerFields = extractRequiredFields(triggerDef.config_schema);
		const triggerConfig =
			automation.trigger_config && typeof automation.trigger_config === "object"
				? (automation.trigger_config as Record<string, unknown>)
				: {};
		for (const field of requiredTriggerFields) {
			const value = triggerConfig[field];
			if (value === undefined || value === null || value === "") {
				issues.push({
					nodeKey: "trigger",
					message: `Trigger is missing required field "${field}"`,
					severity: "error",
				});
			}
		}
		if (
			automation.trigger_type !== "manual" &&
			automation.trigger_type !== "external_api" &&
			!automation.social_account_id
		) {
			issues.push({
				nodeKey: "trigger",
				message: "Trigger is missing a bound account",
				severity: "error",
			});
		}
	}

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
				? triggerDef?.output_labels ?? ["next"]
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
