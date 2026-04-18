import type {
	AutomationNodeSpec,
	SchemaNodeDef,
	SchemaTriggerDef,
} from "./types";

function labelsFromEntries(
	value: unknown,
	fallback: string[],
): string[] {
	if (!Array.isArray(value)) return fallback;
	const labels = value
		.map((entry) =>
			entry && typeof entry === "object" && typeof entry.label === "string"
				? entry.label
				: null,
		)
		.filter((label): label is string => !!label);
	return labels.length > 0 ? labels : fallback;
}

export function resolveNodeOutputLabels(
	node: AutomationNodeSpec | null | undefined,
	def: SchemaNodeDef | null | undefined,
): string[] {
	if (!node) return def?.output_labels ?? ["next"];
	if (node.type === "randomizer") {
		return labelsFromEntries(node.branches, def?.output_labels ?? ["branch_1", "branch_2"]);
	}
	if (node.type === "split_test") {
		return labelsFromEntries(node.variants, def?.output_labels ?? ["variant_a", "variant_b"]);
	}
	return def?.output_labels ?? ["next"];
}

export function resolveSourceOutputLabels(
	sourceKey: string,
	nodesByKey: Map<string, AutomationNodeSpec>,
	schemaByType: Map<string, SchemaNodeDef>,
	triggerDef?: SchemaTriggerDef | null,
): string[] {
	if (sourceKey === "trigger") {
		return triggerDef?.output_labels ?? ["next"];
	}
	const node = nodesByKey.get(sourceKey);
	return resolveNodeOutputLabels(node, node ? schemaByType.get(node.type) ?? null : null);
}
