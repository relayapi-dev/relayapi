import type { MessageBlock, QuickReply } from "../../../schemas/automation-graph";
import { autoLayoutGraph } from "./_layout";
import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

type CommentToDmConfig = {
	post_ids?: string[];
	keyword_filter?: string[];
	public_reply?: string;
	dm_message?: { blocks: MessageBlock[]; quick_replies?: QuickReply[] };
	once_per_user?: boolean;
	fallback_message?: string;
	social_account_id?: string;
};

export function buildCommentToDm(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const cfg = (input.config ?? {}) as CommentToDmConfig;
	const socialAccountId = input.socialAccountId ?? cfg.social_account_id;
	const publicReply = cfg.public_reply?.trim();

	const blocks: MessageBlock[] =
		cfg.dm_message?.blocks && cfg.dm_message.blocks.length > 0
			? cfg.dm_message.blocks
			: [
					{
						id: "txt_dm",
						type: "text",
						text: "Thanks for commenting! Here's the info you asked about.",
					},
				];

	return {
		name: "Comment → DM",
		description:
			"Replies to matching comments on the selected posts with a DM.",
		graph: autoLayoutGraph({
			schema_version: 1,
			root_node_key: publicReply ? "public_reply" : "send_dm",
			nodes: [
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
				{
					key: "send_dm",
					kind: "message",
					title: "DM the commenter",
					config: {
						blocks,
						quick_replies: cfg.dm_message?.quick_replies,
					},
					ports: [],
				},
			],
			edges: publicReply
				? [
						{
							from_node: "public_reply",
							from_port: "next",
							to_node: "send_dm",
							to_port: "in",
						},
					]
				: [],
		}),
		entrypoints: [
			{
				kind: "comment_created",
				config: {
					post_ids: Array.isArray(cfg.post_ids) ? cfg.post_ids : null,
					// Entrypoint key is `keywords` — matcher reads config.keywords
					// (trigger-matcher.ts:190). Template input field remains
					// `keyword_filter` for backwards-compatible dashboard forms.
					keywords: cfg.keyword_filter,
					include_replies: false,
				},
				socialAccountId: socialAccountId ?? null,
				allowReentry: cfg.once_per_user === true ? false : true,
			},
		],
	};
}
