import type { MessageBlock, QuickReply } from "../../../schemas/automation-graph";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type StoryLeadsConfig = {
	story_ids?: string[] | null;
	keyword_filter?: string[];
	dm_message?: { blocks: MessageBlock[]; quick_replies?: QuickReply[] };
	capture_field?: "email" | "phone";
	success_tag?: string;
	social_account_id?: string;
};

export function buildStoryLeads(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const cfg = (input.config ?? {}) as StoryLeadsConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;
	const captureField = cfg.capture_field ?? "email";
	const successTag = cfg.success_tag ?? "story_lead";
	const inputType = captureField === "phone" ? "phone" : "email";

	const promptBlocks: MessageBlock[] =
		cfg.dm_message?.blocks && cfg.dm_message.blocks.length > 0
			? cfg.dm_message.blocks
			: [
					{
						id: "txt_lead",
						type: "text",
						text: `Thanks for replying to our story! Share your ${captureField} and we'll follow up.`,
					},
				];

	return {
		name: "Story leads",
		description:
			"Captures leads from Instagram story replies. Tags and saves the contact field.",
		graph: {
			schema_version: 1,
			root_node_key: "prompt",
			nodes: [
				{
					key: "prompt",
					kind: "message",
					title: "Ask for the lead info",
					config: {
						blocks: promptBlocks,
						quick_replies: cfg.dm_message?.quick_replies,
					},
					ports: [],
				},
				{
					key: "capture",
					kind: "input",
					title: `Capture ${captureField}`,
					config: {
						field: captureField,
						input_type: inputType,
						max_retries: 2,
					},
					ports: [],
				},
				{
					key: "save",
					kind: "action_group",
					title: "Tag + save",
					config: {
						actions: [
							{
								id: "act_tag",
								type: "tag_add",
								tag: successTag,
								on_error: "continue",
							},
							{
								id: "act_field",
								type: "field_set",
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
								text: "Thanks — you're on the list!",
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
					from_node: "prompt",
					from_port: "next",
					to_node: "capture",
					to_port: "in",
				},
				{
					from_node: "capture",
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
		},
		entrypoints: [
			{
				kind: "story_reply",
				config: {
					story_ids: Array.isArray(cfg.story_ids) ? cfg.story_ids : null,
					// Entrypoint key is `keywords` — matcher reads config.keywords
					// (trigger-matcher.ts:201).
					keywords: cfg.keyword_filter,
				},
				socialAccountId: socialAccountId ?? null,
			},
		],
	};
}
