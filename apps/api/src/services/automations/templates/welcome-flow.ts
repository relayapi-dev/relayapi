import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

export function buildWelcomeFlow(
	_input: TemplateBuildInput,
): TemplateBuildOutput {
	return {
		name: "Welcome flow",
		description:
			"Greets new contacts with a friendly message. Wire an entrypoint after creating.",
		graph: {
			schema_version: 1,
			root_node_key: "welcome",
			nodes: [
				{
					key: "welcome",
					kind: "message",
					title: "Welcome message",
					config: {
						blocks: [
							{
								id: "txt_welcome",
								type: "text",
								text: "Hi {{contact.first_name}}! Thanks for reaching out.",
							},
						],
					},
					ports: [],
				},
				{
					key: "done",
					kind: "end",
					title: "End",
					config: { reason: "completed" },
					ports: [],
				},
			],
			edges: [
				{
					from_node: "welcome",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		},
		entrypoints: [],
	};
}
