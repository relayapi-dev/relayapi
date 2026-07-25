import type { MessageBlock } from "../../../schemas/automation-graph";
import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type FollowerGrowthConfig = {
	post_ids?: string[];
	trigger_keyword?: string;
	public_reply?: string;
	dm_message?: { blocks: MessageBlock[] };
	entry_requirements?: {
		must_tag_friends?: number;
		must_share_story?: boolean;
	};
	winner_tag?: string;
	social_account_id?: string;
	daily_cap?: number;
};

export function buildFollowerGrowth(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	if (input.channel !== "instagram") {
		throw new Error("follower_growth is only available for Instagram");
	}
	const cfg = (input.config ?? {}) as FollowerGrowthConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;
	const winnerTag = cfg.winner_tag ?? "contest_qualified";
	const triggerKeyword = cfg.trigger_keyword ?? "enter";
	const mustTagCount = cfg.entry_requirements?.must_tag_friends ?? 0;
	const mustShareStory = cfg.entry_requirements?.must_share_story === true;
	const publicReply = cfg.public_reply?.trim();
	const rulesBlocks: MessageBlock[] = cfg.dm_message?.blocks?.length
		? cfg.dm_message.blocks
		: [
				{
					id: "txt_rules",
					type: "text",
					text: `Thanks for entering!${
						mustTagCount > 0
							? ` Tag at least ${mustTagCount} friend${mustTagCount === 1 ? "" : "s"} in your comment.`
							: ""
					}${
						mustShareStory
							? " Mention us in a story to complete your entry."
							: " You're entered."
					}`,
				},
			];

	const firstNode = publicReply
		? "public_reply"
		: mustTagCount > 0
			? "check_tags"
			: "private_reply";
	const afterPrivateReply = mustShareStory
		? "wait_for_story"
		: "mark_qualified";
	const nodes: TemplateBuildOutput["graph"]["nodes"] = [
		...(publicReply
			? [
					{
						key: "public_reply",
						kind: "action_group",
						title: "Reply publicly",
						config: {
							actions: [
								{
									id: "act_public_reply",
									type: "reply_to_comment",
									text: publicReply,
									on_error: "continue",
								},
							],
						},
						ports: [],
					},
				]
			: []),
		...(mustTagCount > 0
			? [
					{
						key: "check_tags",
						kind: "condition",
						title: "Enough friends tagged?",
						config: {
							predicates: {
								all: [
									{
										field: "state.triggerEvent.payload.mention_count",
										op: "gte",
										value: mustTagCount,
									},
								],
							},
						},
						ports: [],
					},
				]
			: []),
		{
			key: "private_reply",
			kind: "message",
			title: "Send contest private reply",
			config: { blocks: rulesBlocks, delivery: "comment_private_reply" },
			ports: [],
		},
		...(mustShareStory
			? [
					{
						key: "wait_for_story",
						kind: "wait_event",
						title: "Wait for story mention",
						config: { event_kinds: ["story_mention"], timeout_min: 10_080 },
						ports: [],
					},
				]
			: []),
		{
			key: "mark_qualified",
			kind: "action_group",
			title: "Mark qualified",
			config: {
				actions: [
					{
						id: "act_tag_qualified",
						type: "tag_add",
						tag: winnerTag,
						on_error: "abort",
					},
				],
			},
			ports: [],
		},
		{
			key: "done",
			kind: "end",
			title: "Qualified",
			config: { reason: "contest_qualified" },
			ports: [],
		},
		{
			key: "incomplete",
			kind: "end",
			title: "Requirements not met",
			config: { reason: "contest_requirements_not_met" },
			ports: [],
		},
	];

	const edges: TemplateBuildOutput["graph"]["edges"] = [
		...(publicReply
			? [
					{
						from_node: "public_reply",
						from_port: "next",
						to_node: mustTagCount > 0 ? "check_tags" : "private_reply",
						to_port: "in",
					},
				]
			: []),
		...(mustTagCount > 0
			? [
					{
						from_node: "check_tags",
						from_port: "true",
						to_node: "private_reply",
						to_port: "in",
					},
					{
						from_node: "check_tags",
						from_port: "false",
						to_node: "incomplete",
						to_port: "in",
					},
				]
			: []),
		{
			from_node: "private_reply",
			from_port: "next",
			to_node: afterPrivateReply,
			to_port: "in",
		},
		...(mustShareStory
			? [
					{
						from_node: "wait_for_story",
						from_port: "received",
						to_node: "mark_qualified",
						to_port: "in",
					},
					{
						from_node: "wait_for_story",
						from_port: "timeout",
						to_node: "incomplete",
						to_port: "in",
					},
				]
			: []),
		{
			from_node: "mark_qualified",
			from_port: "next",
			to_node: "done",
			to_port: "in",
		},
	];

	return {
		name: "Follower growth contest",
		description:
			"Qualifies Instagram contest comments and optionally waits for a story mention as proof.",
		graph: autoLayoutGraph({
			schema_version: 1,
			root_node_key: firstNode,
			nodes,
			edges,
		}),
		entrypoints: [
			{
				kind: "comment_created",
				config: {
					post_ids: cfg.post_ids?.length ? cfg.post_ids : null,
					keywords: [triggerKeyword],
					include_replies: false,
				},
				socialAccountId: socialAccountId ?? null,
				dailyCap: cfg.daily_cap ?? null,
			},
		],
	};
}
