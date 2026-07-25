import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

export function buildLeadCapture(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const tagName =
		typeof input.config?.tag === "string"
			? (input.config.tag as string)
			: "lead";
	const captureField =
		input.config?.capture_field === "phone" ? "phone" : "email";
	const capturePrompt =
		captureField === "phone"
			? "Welcome! What phone number should we use to reach you?"
			: "Welcome! What email address should we use to reach you?";

	return {
		name: "Lead capture",
		description: `Asks a visitor for their ${captureField}, tags them as a lead, and confirms.`,
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
								text: capturePrompt,
							},
						],
					},
					ports: [],
				},
				{
					key: "ask_email",
					kind: "input",
					title: `Capture ${captureField}`,
					config: {
						field: captureField,
						input_type: captureField,
						max_retries: 2,
					},
					ports: [],
				},
				{
					key: "save",
					kind: "action_group",
					title: `Tag + save ${captureField}`,
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
								type: "contact_field_set",
								field: captureField,
								value: `{{state.${captureField}}}`,
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
