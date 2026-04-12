import { z } from "@hono/zod-openapi";
import { PlatformEnum } from "./common";
import { ConversationStatusEnum, ConversationTypeEnum, FeedConversationItem } from "./inbox-feed";

// =====================
// Classify
// =====================

export const ClassifyBody = z.object({
	messages: z
		.array(
			z.object({
				id: z.string().optional().describe("Optional message ID for correlation"),
				text: z.string().describe("Message text to classify"),
			}),
		)
		.min(1)
		.max(50)
		.describe("Messages to classify (1-50)"),
});

export const ClassifyResultItem = z.object({
	id: z.string().optional().describe("Correlated message ID"),
	sentiment: z.object({
		score: z.number().min(-1).max(1).describe("Sentiment score (-1.0 to 1.0)"),
		label: z
			.enum(["positive", "neutral", "negative"])
			.describe("Sentiment label"),
	}),
	intent: z
		.enum([
			"question",
			"complaint",
			"compliment",
			"spam",
			"feedback",
			"general",
		])
		.describe("Detected intent"),
	urgency: z.enum(["high", "medium", "low"]).describe("Urgency level"),
	requires_response: z.boolean().describe("Whether a response is needed"),
});

export const ClassifyResponse = z.array(ClassifyResultItem);

// =====================
// Suggest Reply
// =====================

export const SuggestReplyBody = z.object({
	conversation_id: z.string().describe("Conversation ID"),
	tone: z.string().optional().describe("Desired tone (e.g. professional, friendly)"),
	max_suggestions: z.number().int().min(1).max(10).optional().describe("Max suggestions to generate"),
	context: z.string().optional().describe("Additional context for reply generation"),
});

export const SuggestReplyResponse = z.object({
	suggestions: z.array(
		z.object({
			text: z.string().describe("Suggested reply text"),
			tone: z.string().describe("Tone of the suggestion"),
			confidence: z.number().min(0).max(1).describe("Confidence score"),
		}),
	),
});

// =====================
// Summarize
// =====================

export const SummarizeBody = z.object({
	conversation_id: z.string().describe("Conversation ID"),
});

export const SummarizeResponse = z.object({
	summary: z.string().describe("Conversation summary"),
	key_topics: z.array(z.string()).describe("Key topics discussed"),
	action_needed: z.string().describe("Next action needed"),
	message_count: z.number().describe("Total messages in conversation"),
	timespan: z.string().describe("Time range of the conversation"),
});

// =====================
// Priorities
// =====================

export const PrioritiesQuery = z.object({
	type: ConversationTypeEnum.optional().describe("Filter by conversation type"),
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	status: ConversationStatusEnum.optional().describe("Filter by status"),
	labels: z.string().optional().describe("Comma-separated list of labels"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

export const PrioritizedConversationItem = FeedConversationItem.extend({
	priority_score: z.number().describe("Calculated priority score"),
});

export const PrioritiesResponse = z.object({
	data: z.array(PrioritizedConversationItem),
	next_cursor: z.string().nullable().describe("Cursor for next page"),
	has_more: z.boolean().describe("Whether more items exist"),
});
