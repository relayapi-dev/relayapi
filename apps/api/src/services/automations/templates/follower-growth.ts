import type { MessageBlock, QuickReply } from "../../../schemas/automation-graph";
import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type FollowerGrowthConfig = {
	post_ids?: string[];
	trigger_keyword?: string;
	public_reply?: string;
	dm_message?: { blocks: MessageBlock[]; quick_replies?: QuickReply[] };
	entry_requirements?: {
		must_tag_friends?: number;
		must_share_story?: boolean;
	};
	winner_tag?: string;
	social_account_id?: string;
};

export function buildFollowerGrowth(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const cfg = (input.config ?? {}) as FollowerGrowthConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;
	const winnerTag = cfg.winner_tag ?? "contest_winner";
	const triggerKeyword = cfg.trigger_keyword ?? "enter";
	const mustTagCount = cfg.entry_requirements?.must_tag_friends ?? 0;

	const rulesBlocks: MessageBlock[] =
		cfg.dm_message?.blocks && cfg.dm_message.blocks.length > 0
			? cfg.dm_message.blocks
			: [
					{
						id: "txt_rules",
						type: "text",
						text: `Welcome to the contest! To qualify${
							mustTagCount > 0
								? `, tag at least ${mustTagCount} friend${mustTagCount === 1 ? "" : "s"} in the original post`
								: ""
						}${
							cfg.entry_requirements?.must_share_story
								? " and share this to your story"
								: ""
						}.`,
					},
				];

	// Predicate — the public comment's friend-tag count (sourced from the
	// entrypoint payload) meets the contest rule.
	const qualifyPredicates = {
		all: [
			...(mustTagCount > 0
				? [
						{
							field: "state.mention_count",
							op: "gte",
							value: mustTagCount,
						},
					]
				: []),
			...(cfg.entry_requirements?.must_share_story
				? [
						{
							field: "state.shared_to_story",
							op: "eq",
							value: true,
						},
					]
				: []),
		],
	};

	return {
		name: "Follower growth contest",
		description:
			"Matches contest comments on the selected posts. Confirms winners via DM.",
		graph: autoLayoutGraph({
			schema_version: 1,
			root_node_key: "rules",
			nodes: [
				{
					key: "rules",
					kind: "message",
					title: "Explain contest rules",
					config: {
						blocks: rulesBlocks,
						quick_replies: cfg.dm_message?.quick_replies,
					},
					ports: [],
				},
				{
					key: "check",
					kind: "condition",
					title: "Does the entry qualify?",
					config: { predicates: qualifyPredicates },
					ports: [],
				},
				{
					key: "mark_winner",
					kind: "action_group",
					title: "Tag as winner",
					config: {
						actions: [
							{
								id: "act_tag_winner",
								type: "tag_add",
								tag: winnerTag,
								on_error: "continue",
							},
						],
					},
					ports: [],
				},
				{
					key: "winner_dm",
					kind: "message",
					title: "Congrats DM",
					config: {
						blocks: [
							{
								id: "txt_winner",
								type: "text",
								text: "Congratulations — you're qualified for the contest!",
							},
						],
					},
					ports: [],
				},
				{
					key: "reminder_dm",
					kind: "message",
					title: "Entry reminder",
					config: {
						blocks: [
							{
								id: "txt_reminder",
								type: "text",
								text: "Thanks for entering! You haven't met the entry rules yet — check the rules above and try again.",
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
					from_node: "rules",
					from_port: "next",
					to_node: "check",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "true",
					to_node: "mark_winner",
					to_port: "in",
				},
				{
					from_node: "mark_winner",
					from_port: "next",
					to_node: "winner_dm",
					to_port: "in",
				},
				{
					from_node: "winner_dm",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "false",
					to_node: "reminder_dm",
					to_port: "in",
				},
				{
					from_node: "reminder_dm",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		}),
		entrypoints: [
			{
				kind: "comment_created",
				config: {
					post_ids: Array.isArray(cfg.post_ids) ? cfg.post_ids : null,
					// Entrypoint key is `keywords` — matcher reads config.keywords
					// (trigger-matcher.ts:190).
					keywords: [triggerKeyword],
				},
				socialAccountId: socialAccountId ?? null,
			},
		],
	};
}
