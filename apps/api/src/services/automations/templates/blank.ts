import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

export function buildBlank(_input: TemplateBuildInput): TemplateBuildOutput {
	return {
		name: "Untitled flow",
		description: "Empty flow. Drag nodes from the palette to start.",
		graph: {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		},
		entrypoints: [],
	};
}
