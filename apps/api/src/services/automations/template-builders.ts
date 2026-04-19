import { z } from "@hono/zod-openapi";
import {
	AutomationCreateSpec,
	CommentToDmTemplateInput,
	FollowToDmTemplateInput,
	GiveawayTemplateInput,
	KeywordReplyTemplateInput,
	WelcomeDmTemplateInput,
} from "../../schemas/automations";

export type MaterializedTemplateSpec = z.infer<typeof AutomationCreateSpec>;

export interface UnavailableTemplateResult {
	kind: "unavailable";
	message: string;
}

const ENROLLED_CONTACT = "enrolled_contact" as const;

function parseTemplateSpec(
	spec: z.input<typeof AutomationCreateSpec>,
): MaterializedTemplateSpec {
	return AutomationCreateSpec.parse({
		status: "draft",
		...spec,
	});
}

function buildTextMessageNode(key: string, text: string) {
	return {
		type: "message_text" as const,
		key,
		text,
		recipient_mode: ENROLLED_CONTACT,
	};
}

export function buildCommentToDmTemplate(
	body: z.input<typeof CommentToDmTemplateInput>,
): MaterializedTemplateSpec {
	const input = CommentToDmTemplateInput.parse(body);
	return parseTemplateSpec({
		name: input.name,
		workspace_id: input.workspace_id,
		channel: "instagram",
		trigger: {
			type: "instagram_comment",
			account_id: input.account_id,
			config: {
				keywords: input.keywords,
				match_mode: input.match_mode,
				post_id: input.post_id ?? null,
			},
			filters: {},
		},
		nodes: [
			buildTextMessageNode("send_dm", input.dm_message),
			...(input.public_reply
				? [
						{
							type: "instagram_reply_to_comment" as const,
							key: "public_reply",
							text: input.public_reply,
						},
					]
				: []),
		],
		edges: [
			{ from: "trigger", to: "send_dm" },
			...(input.public_reply
				? [{ from: "send_dm", to: "public_reply" }]
				: []),
		],
		allow_reentry: !input.once_per_user,
	});
}

export function buildWelcomeDmTemplate(
	body: z.input<typeof WelcomeDmTemplateInput>,
): MaterializedTemplateSpec {
	const input = WelcomeDmTemplateInput.parse(body);
	const triggerTypeByChannel = {
		instagram: "instagram_dm",
		facebook: "facebook_dm",
		whatsapp: "whatsapp_message",
	} as const satisfies Record<
		z.input<typeof WelcomeDmTemplateInput>["channel"],
		MaterializedTemplateSpec["trigger"]["type"]
	>;

	return parseTemplateSpec({
		name: input.name,
		workspace_id: input.workspace_id,
		channel: input.channel,
		trigger: {
			type: triggerTypeByChannel[input.channel],
			account_id: input.account_id,
			config: {},
			filters: {},
		},
		nodes: [buildTextMessageNode("welcome", input.welcome_message)],
		edges: [{ from: "trigger", to: "welcome" }],
	});
}

export function buildKeywordReplyTemplate(
	body: z.input<typeof KeywordReplyTemplateInput>,
): MaterializedTemplateSpec {
	const input = KeywordReplyTemplateInput.parse(body);
	const triggerTypeByChannel = {
		instagram: "instagram_dm",
		facebook: "facebook_dm",
		whatsapp: "whatsapp_message",
		telegram: "telegram_message",
		twitter: "twitter_dm",
		reddit: "reddit_dm",
	} as const satisfies Record<
		z.input<typeof KeywordReplyTemplateInput>["channel"],
		MaterializedTemplateSpec["trigger"]["type"]
	>;

	return parseTemplateSpec({
		name: input.name,
		workspace_id: input.workspace_id,
		channel: input.channel,
		trigger: {
			type: triggerTypeByChannel[input.channel],
			account_id: input.account_id,
			config: {
				keywords: input.keywords,
				match_mode: input.match_mode,
			},
			filters: {},
		},
		nodes: [buildTextMessageNode("reply", input.reply_message)],
		edges: [{ from: "trigger", to: "reply" }],
	});
}

export function buildFollowToDmTemplate(
	body: z.input<typeof FollowToDmTemplateInput>,
): MaterializedTemplateSpec {
	const input = FollowToDmTemplateInput.parse(body);
	return parseTemplateSpec({
		name: input.name,
		workspace_id: input.workspace_id,
		channel: "instagram",
		trigger: {
			type: "manual",
			account_id: input.account_id,
			config: {},
			filters: {},
		},
		nodes: [buildTextMessageNode("welcome", input.welcome_message)],
		edges: [{ from: "trigger", to: "welcome" }],
	});
}

export function buildStoryReplyTemplate(): UnavailableTemplateResult {
	return {
		kind: "unavailable",
		message:
			"The story-reply template is unavailable until instagram_story_reply enrollments are supported by the runtime.",
	};
}

export function buildGiveawayTemplate(
	body: z.input<typeof GiveawayTemplateInput>,
): MaterializedTemplateSpec {
	const input = GiveawayTemplateInput.parse(body);
	return parseTemplateSpec({
		name: input.name,
		workspace_id: input.workspace_id,
		channel: input.channel,
		trigger: {
			type: input.channel === "facebook" ? "facebook_comment" : "instagram_comment",
			account_id: input.account_id,
			config: {
				keywords: input.entry_keywords,
				match_mode: "contains",
				post_id: input.post_id ?? null,
			},
			filters: {},
		},
		nodes: [
			{
				type: "tag_add" as const,
				key: "tag_entry",
				tag: input.entry_tag,
			},
			buildTextMessageNode("confirm_dm", input.confirmation_dm),
		],
		edges: [
			{ from: "trigger", to: "tag_entry" },
			{ from: "tag_entry", to: "confirm_dm" },
		],
	});
}
