import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

export function buildLeadCapture(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const tagName =
		typeof input.config?.tag === "string" ? (input.config.tag as string) : "lead";
	const emailField =
		typeof input.config?.capture_field === "string"
			? (input.config.capture_field as string)
			: "email";

	return {
		name: "Lead capture",
		description:
			"Asks a visitor for their email, tags them as a lead, and confirms.",
		graph: autoLayoutGraph({
			schema_version: 1,
			root_node_key: "welcome",
			nodes: [
				{
					key: "welcome",
					kind: "message",
					title: "Introduce yourself",
					config: {
						blocks: [
							{
								id: "txt_intro",
								type: "text",
								text: "Welcome! I'd love to know more about you.",
							},
						],
					},
					ports: [],
				},
				{
					key: "ask_email",
					kind: "input",
					title: "Capture email",
					config: {
						field: emailField,
						input_type: "email",
						max_retries: 2,
					},
					ports: [],
				},
				{
					key: "save",
					kind: "action_group",
					title: "Tag + save email",
					config: {
						actions: [
							{
								id: "act_tag",
								type: "tag_add",
								tag: tagName,
								on_error: "continue",
							},
							{
								id: "act_field",
								type: "field_set",
								field: emailField,
								value: `{{state.${emailField}}}`,
								on_error: "continue",
							},
						],
					},
					ports: [],
				},
				{
					key: "thanks",
					kind: "message",
					title: "Confirm",
					config: {
						blocks: [
							{
								id: "txt_thanks",
								type: "text",
								text: "Thanks! We'll be in touch.",
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
					to_node: "ask_email",
					to_port: "in",
				},
				{
					from_node: "ask_email",
					from_port: "captured",
					to_node: "save",
					to_port: "in",
				},
				{
					from_node: "save",
					from_port: "next",
					to_node: "thanks",
					to_port: "in",
				},
				{
					from_node: "thanks",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		}),
		entrypoints: [],
	};
}
