import type { MessageBlock } from "../../../schemas/automation-graph";
import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type FollowToDmConfig = {
	social_account_id?: string;
	dm_message?: { blocks: MessageBlock[] };
	daily_cap?: number;
	cooldown_hours?: number;
};

export function buildFollowToDm(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	if (input.channel !== "instagram") {
		throw new Error("follow_to_dm is only available for Instagram");
	}
	const cfg = (input.config ?? {}) as FollowToDmConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;
	const blocks: MessageBlock[] = cfg.dm_message?.blocks?.length
		? cfg.dm_message.blocks
		: [
				{
					id: "txt_welcome_follower",
					type: "text",
					text: "Thanks for following! Glad to have you here.",
				},
			];

	return {
		name: "Follower-first DM",
		description:
			"On a follower's first inbound Instagram DM, verifies the follow relationship before welcoming them.",
		graph: autoLayoutGraph({
			schema_version: 1,
			root_node_key: "check_follow",
			nodes: [
				{
					key: "check_follow",
					kind: "social_profile_check",
					title: "Does this person follow us?",
					config: { field: "is_user_follow_business" },
					ports: [],
				},
				{
					key: "welcome",
					kind: "message",
					title: "Welcome follower",
					config: {
						blocks,
					},
					ports: [],
				},
				{
					key: "tag",
					kind: "action_group",
					title: "Tag follower",
					config: {
						actions: [
							{
								id: "act_tag_follower",
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
					title: "Welcomed",
					config: { reason: "follower_welcomed" },
					ports: [],
				},
				{
					key: "not_follower",
					kind: "end",
					title: "Not a follower",
					config: { reason: "not_a_follower" },
					ports: [],
				},
			],
			edges: [
				{
					from_node: "check_follow",
					from_port: "follows",
					to_node: "welcome",
					to_port: "in",
				},
				{
					from_node: "check_follow",
					from_port: "not_follows",
					to_node: "not_follower",
					to_port: "in",
				},
				{
					from_node: "check_follow",
					from_port: "error",
					to_node: "not_follower",
					to_port: "in",
				},
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
		}),
		entrypoints: [
			{
				kind: "dm_received",
				config: { first_message_only: true },
				socialAccountId: socialAccountId ?? null,
				allowReentry: false,
				reentryCooldownMin: Math.round((cfg.cooldown_hours ?? 0) * 60),
				dailyCap: cfg.daily_cap ?? null,
			},
		],
	};
}
