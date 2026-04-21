import type { MessageBlock, QuickReply } from "../../../schemas/automation-graph";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type FollowToDmConfig = {
	social_account_id?: string;
	dm_message?: { blocks: MessageBlock[]; quick_replies?: QuickReply[] };
	max_sends_per_day?: number;
	cooldown_between_sends_ms?: number;
	skip_if_already_messaged?: boolean;
};

export function buildFollowToDm(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const cfg = (input.config ?? {}) as FollowToDmConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;

	const blocks: MessageBlock[] =
		cfg.dm_message?.blocks && cfg.dm_message.blocks.length > 0
			? cfg.dm_message.blocks
			: [
					{
						id: "txt_welcome_follower",
						type: "text",
						text: "Thanks for following! Glad to have you.",
					},
				];

	return {
		name: "Follow → DM",
		description:
			"Sends a welcome DM to new followers and tags them for easy filtering.",
		graph: {
			schema_version: 1,
			root_node_key: "welcome",
			nodes: [
				{
					key: "welcome",
					kind: "message",
					title: "Welcome DM",
					config: {
						blocks,
						quick_replies: cfg.dm_message?.quick_replies,
					},
					ports: [],
				},
				{
					key: "tag",
					kind: "action_group",
					title: "Tag as new follower",
					config: {
						actions: [
							{
								id: "act_tag_new_follower",
								type: "tag_add",
								tag: "new_follower",
								on_error: "continue",
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
					to_node: "tag",
					to_port: "in",
				},
				{
					from_node: "tag",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		},
		entrypoints: [
			{
				kind: "follow",
				config: {
					max_sends_per_day: cfg.max_sends_per_day,
					cooldown_between_sends_ms: cfg.cooldown_between_sends_ms,
					skip_if_already_messaged: cfg.skip_if_already_messaged ?? true,
				},
				socialAccountId: socialAccountId ?? null,
			},
		],
	};
}
