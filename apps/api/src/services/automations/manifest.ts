import { z } from "@hono/zod-openapi";
import {
	AUTOMATION_CHANNELS,
	AUTOMATION_NODE_TYPES,
	AUTOMATION_TRIGGER_TYPES,
	AutomationNodeType,
	AutomationNodeSpec,
	AutomationTriggerType,
	CommentToDmTemplateInput,
	FollowToDmTemplateInput,
	GiveawayTemplateInput,
	KeywordReplyTemplateInput,
	RUNTIME_SUPPORTED_TRIGGER_TYPES,
	STUBBED_NODE_TYPES,
	WelcomeDmTemplateInput,
} from "../../schemas/automations";

type TriggerTransport = "webhook" | "polling" | "streaming";
type NodeCategory =
	| "content"
	| "input"
	| "logic"
	| "ai"
	| "action"
	| "ops"
	| "platform_send";

export interface AutomationTriggerManifestEntry {
	type: AutomationTriggerType;
	description: string;
	channel: (typeof AUTOMATION_CHANNELS)[number];
	tier: number;
	transport: TriggerTransport;
	config_schema: unknown;
	output_labels: string[];
	runtime_supported: boolean;
}

export interface AutomationNodeManifestEntry {
	type: AutomationNodeType;
	description: string;
	category: NodeCategory;
	fields_schema: unknown;
	output_labels: string[];
	stubbed: boolean;
}

export interface AutomationTemplateManifestEntry {
	id: string;
	name: string;
	description: string;
	input_schema: unknown;
}

const BASE_NODE_FIELDS = new Set([
	"type",
	"key",
	"notes",
	"canvas_x",
	"canvas_y",
]);

function buildNodeConfigSchemaMap(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const options = (
		AutomationNodeSpec as unknown as {
			options: Array<z.ZodObject<z.ZodRawShape>>;
		}
	).options;
	for (const opt of options) {
		try {
			const shape = opt.shape;
			const typeField = shape.type as unknown as { value?: string } | undefined;
			const typeName = typeField?.value;
			if (!typeName) continue;
			const mask: Record<string, true> = {};
			for (const base of BASE_NODE_FIELDS) {
				if (base in shape) mask[base] = true;
			}
			const configOnly = opt.omit(mask as { [K in keyof typeof shape]?: true });
			out[typeName] = z.toJSONSchema(configOnly);
		} catch {
			try {
				const shape = opt.shape;
				const typeField = shape.type as unknown as { value?: string } | undefined;
				if (typeField?.value) out[typeField.value] = {};
			} catch {
				// Skip malformed union members entirely.
			}
		}
	}
	return out;
}

function buildTriggerConfigSchemaMap(): Record<string, unknown> {
	const keywordMatchSchema = z.object({
		keywords: z
			.array(z.string())
			.min(1)
			.max(50)
			.optional()
			.describe("Optional keyword list. Leave empty to match every inbound event."),
		match_mode: z
			.enum(["contains", "exact"])
			.optional()
			.describe("How inbound text is matched against the keyword list."),
	});

	const commentTriggerSchema = keywordMatchSchema.extend({
		post_id: z
			.string()
			.nullable()
			.optional()
			.describe("Optional platform post ID. Leave empty to match comments on any post."),
	});

	return {
		instagram_comment: z.toJSONSchema(commentTriggerSchema),
		facebook_comment: z.toJSONSchema(commentTriggerSchema),
		instagram_dm: z.toJSONSchema(keywordMatchSchema),
		facebook_dm: z.toJSONSchema(keywordMatchSchema),
		whatsapp_message: z.toJSONSchema(keywordMatchSchema),
		telegram_message: z.toJSONSchema(keywordMatchSchema),
		twitter_dm: z.toJSONSchema(keywordMatchSchema),
		reddit_dm: z.toJSONSchema(keywordMatchSchema),
		sms_received: z.toJSONSchema(keywordMatchSchema),
		manual: {},
		external_api: {},
	};
}

function buildTriggerDescription(type: string): string {
	const map: Record<string, string> = {
		instagram_comment: "Fires when a user comments on an Instagram post or reel",
		instagram_dm: "Fires on any inbound Instagram direct message",
		facebook_comment: "Fires when a user comments on a Facebook post",
		facebook_dm: "Fires on any inbound Facebook Messenger message",
		instagram_follow_to_dm: "Fires when a new user follows the account",
		whatsapp_message: "Fires on any inbound WhatsApp message",
		twitter_dm: "Fires on any inbound X direct message",
		reddit_dm: "Fires on any inbound Reddit direct message",
		whatsapp_keyword:
			"Reserved alias for WhatsApp keyword triggers; use whatsapp_message with keyword config today",
		telegram_message: "Fires on any inbound Telegram message",
		telegram_command: "Fires when a Telegram user sends a bot command",
		scheduled_time: "Fires on a cron schedule",
		manual: "No automatic trigger — enrolled via API",
	};
	return map[type] ?? `Trigger type: ${type}`;
}

function triggerChannel(type: string): (typeof AUTOMATION_CHANNELS)[number] {
	for (const channel of AUTOMATION_CHANNELS) {
		if (channel !== "multi" && type.startsWith(`${channel}_`)) return channel;
	}
	return "multi";
}

function triggerTier(type: string): number {
	const tier1 = [
		"instagram",
		"facebook",
		"whatsapp",
		"telegram",
		"discord",
		"sms",
		"twitter",
		"bluesky",
	];
	const tier2 = [
		"threads",
		"youtube",
		"linkedin",
		"mastodon",
		"reddit",
		"googlebusiness",
	];
	const tier3 = ["beehiiv", "kit", "mailchimp"];
	for (const platform of tier1) if (type.startsWith(`${platform}_`)) return 1;
	for (const platform of tier2) if (type.startsWith(`${platform}_`)) return 2;
	for (const platform of tier3) if (type.startsWith(`${platform}_`)) return 3;
	return 0;
}

function triggerTransport(type: string): TriggerTransport {
	if (
		type.startsWith("reddit_") ||
		type.startsWith("linkedin_") ||
		type.startsWith("youtube_")
	) {
		return "polling";
	}
	if (type.startsWith("mastodon_") || type.startsWith("bluesky_")) {
		return "streaming";
	}
	return "webhook";
}

function nodeDescription(type: string): string {
	if (type === "trigger") return "Virtual root node — the automation's entry point";
	if (type.startsWith("message_")) return `Send a ${type.slice(8)} message to the contact`;
	if (type.startsWith("user_input_")) {
		return `Ask the contact for ${type.slice(11)} and save to a custom field`;
	}
	if (type === "condition") return "Branch on contact tags, fields, or captured state";
	if (type === "smart_delay") return "Wait a fixed duration before continuing";
	if (type === "randomizer") return "Split into weighted random branches";
	if (type === "split_test") return "Route contacts into weighted experiment variants";
	if (type === "subscription_add") return "Subscribe the enrolled contact to a list";
	if (type === "subscription_remove") return "Unsubscribe the enrolled contact from a list";
	if (type === "segment_add") return "Add the enrolled contact to a static segment";
	if (type === "segment_remove") {
		return "Remove the enrolled contact from a static segment";
	}
	if (type === "notify_admin") {
		return "Send an internal notification to organization members";
	}
	if (type === "conversation_assign") {
		return "Assign the linked inbox conversation to an organization user";
	}
	if (type === "conversation_status") return "Update the linked inbox conversation status";
	if (type === "http_request") {
		return "Call an external HTTP endpoint and optionally capture the response";
	}
	if (type === "webhook_out") {
		return "Deliver a signed event payload to a RelayAPI webhook endpoint";
	}
	if (type === "ai_agent") {
		return "Hand the conversation to an AI agent with a knowledge base";
	}
	if (type === "goto") return "Jump to another node in the graph";
	if (type === "end") return "Terminate the automation";
	return type;
}

function nodeCategory(type: string): NodeCategory {
	if (type === "trigger") return "logic";
	if (type.startsWith("message_")) return "content";
	if (type.startsWith("user_input_")) return "input";
	if (
		[
			"condition",
			"smart_delay",
			"randomizer",
			"split_test",
			"goto",
			"end",
			"subflow_call",
		].includes(type)
	) {
		return "logic";
	}
	if (["ai_step", "ai_agent", "ai_intent_router"].includes(type)) return "ai";
	if (
		[
			"tag_add",
			"tag_remove",
			"field_set",
			"field_clear",
			"subscription_add",
			"subscription_remove",
			"segment_add",
			"segment_remove",
		].includes(type)
	) {
		return "action";
	}
	if (
		[
			"notify_admin",
			"conversation_assign",
			"conversation_status",
			"http_request",
			"webhook_out",
		].includes(type)
	) {
		return "ops";
	}
	return "platform_send";
}

function nodeOutputLabels(type: string): string[] {
	if (type === "condition") return ["yes", "no"];
	if (type === "randomizer") return ["branch_1", "branch_2", "branch_N"];
	if (type === "split_test") return ["variant_a", "variant_b"];
	if (type.startsWith("user_input_")) return ["captured", "no_match", "timeout"];
	if (type === "ai_agent") return ["complete", "handoff"];
	if (type === "ai_intent_router") return ["intent_1", "intent_2"];
	return ["next"];
}

const NODE_CONFIG_SCHEMA_MAP = buildNodeConfigSchemaMap();
const TRIGGER_CONFIG_SCHEMA_MAP = buildTriggerConfigSchemaMap();

export const AUTOMATION_TEMPLATE_MANIFEST: AutomationTemplateManifestEntry[] = [
	{
		id: "comment-to-dm",
		name: "Comment to DM",
		description: "Reply to an Instagram comment + send a DM to the commenter",
		input_schema: z.toJSONSchema(CommentToDmTemplateInput),
	},
	{
		id: "welcome-dm",
		name: "Welcome DM",
		description: "Send a welcome DM when a contact starts a conversation",
		input_schema: z.toJSONSchema(WelcomeDmTemplateInput),
	},
	{
		id: "keyword-reply",
		name: "Keyword Reply",
		description: "Reply to DMs matching a keyword",
		input_schema: z.toJSONSchema(KeywordReplyTemplateInput),
	},
	{
		id: "follow-to-dm",
		name: "Follow to DM",
		description: "DM new followers on Instagram",
		input_schema: z.toJSONSchema(FollowToDmTemplateInput),
	},
	{
		id: "giveaway",
		name: "Giveaway",
		description: "Run a giveaway that enters users who comment a keyword",
		input_schema: z.toJSONSchema(GiveawayTemplateInput),
	},
];

export const AUTOMATION_TRIGGER_MANIFEST: AutomationTriggerManifestEntry[] =
	AUTOMATION_TRIGGER_TYPES.map((type) => ({
		type,
		description: buildTriggerDescription(type),
		channel: triggerChannel(type),
		tier: triggerTier(type),
		transport: triggerTransport(type),
		config_schema: TRIGGER_CONFIG_SCHEMA_MAP[type] ?? {},
		output_labels: ["next"],
		runtime_supported: RUNTIME_SUPPORTED_TRIGGER_TYPES.has(type),
	}));

export const PUBLISHED_AUTOMATION_TRIGGER_MANIFEST =
	AUTOMATION_TRIGGER_MANIFEST.filter((entry) => entry.runtime_supported);

export const AUTOMATION_NODE_MANIFEST: AutomationNodeManifestEntry[] =
	AUTOMATION_NODE_TYPES.map((type) => ({
		type,
		description: nodeDescription(type),
		category: nodeCategory(type),
		fields_schema: NODE_CONFIG_SCHEMA_MAP[type] ?? {},
		output_labels: nodeOutputLabels(type),
		stubbed: STUBBED_NODE_TYPES.has(type),
	}));

export const PUBLISHED_AUTOMATION_NODE_MANIFEST = AUTOMATION_NODE_MANIFEST.filter(
	(entry) => !entry.stubbed,
);

export function assertAutomationManifestIntegrity(): void {
	const triggerTypes = new Set(AUTOMATION_TRIGGER_MANIFEST.map((entry) => entry.type));
	const missingTriggers = AUTOMATION_TRIGGER_TYPES.filter((type) => !triggerTypes.has(type));
	if (missingTriggers.length > 0) {
		throw new Error(`Trigger manifest missing entries for: ${missingTriggers.join(", ")}`);
	}

	const runtimeTriggerWithoutSchema = AUTOMATION_TRIGGER_MANIFEST.filter(
		(entry) => entry.runtime_supported && entry.config_schema === undefined,
	).map((entry) => entry.type);
	if (runtimeTriggerWithoutSchema.length > 0) {
		throw new Error(
			`Trigger manifest missing config schema for: ${runtimeTriggerWithoutSchema.join(", ")}`,
		);
	}

	const nodeTypes = new Set(AUTOMATION_NODE_MANIFEST.map((entry) => entry.type));
	const missingNodes = AUTOMATION_NODE_TYPES.filter((type) => !nodeTypes.has(type));
	if (missingNodes.length > 0) {
		throw new Error(`Node manifest missing entries for: ${missingNodes.join(", ")}`);
	}

	const runtimeNodeWithoutSchema = AUTOMATION_NODE_MANIFEST.filter(
		(entry) => !entry.stubbed && entry.fields_schema === undefined,
	).map((entry) => entry.type);
	if (runtimeNodeWithoutSchema.length > 0) {
		throw new Error(
			`Node manifest missing config schema for: ${runtimeNodeWithoutSchema.join(", ")}`,
		);
	}

	const templateIds = new Set(AUTOMATION_TEMPLATE_MANIFEST.map((entry) => entry.id));
	const expectedTemplateIds = [
		"comment-to-dm",
		"welcome-dm",
		"keyword-reply",
		"follow-to-dm",
		"giveaway",
	];
	const missingTemplates = expectedTemplateIds.filter((id) => !templateIds.has(id));
	if (missingTemplates.length > 0) {
		throw new Error(`Template manifest missing entries for: ${missingTemplates.join(", ")}`);
	}
}
