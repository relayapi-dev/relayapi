import { z } from "@hono/zod-openapi";
import { PlatformEnum } from "./common";

// =====================
// Conversation Feed
// =====================

export const ConversationTypeEnum = z.enum(["comment_thread", "dm", "review"]);
export const ConversationStatusEnum = z.enum(["open", "archived", "snoozed"]);

export const FeedConversationItem = z.object({
	id: z.string().describe("Conversation ID"),
	platform: PlatformEnum,
	type: ConversationTypeEnum.describe("Conversation type"),
	account_id: z.string().describe("Social account ID"),
	participant_name: z.string().nullable().describe("Participant display name"),
	participant_avatar: z.string().nullable().describe("Participant avatar URL"),
	participant_metadata: z.any().nullable().optional().describe("Platform-specific participant data (e.g. Instagram profile)"),
	status: ConversationStatusEnum.describe("Conversation status"),
	assigned_user_id: z.string().nullable().describe("Assigned organization user ID"),
	priority: z.string().nullable().describe("Priority level"),
	labels: z.array(z.string()).describe("Labels"),
	unread_count: z.number().describe("Unread message count"),
	message_count: z.number().describe("Total message count"),
	last_message_text: z.string().nullable().describe("Last message text"),
	last_message_at: z.string().nullable().describe("Last message timestamp"),
	last_message_direction: z.string().nullable().describe("Last message direction"),
	created_at: z.string().describe("Created timestamp"),
	updated_at: z.string().describe("Updated timestamp"),
});

export const FeedQuery = z.object({
	type: ConversationTypeEnum.optional().describe("Filter by conversation type"),
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	status: ConversationStatusEnum.optional().default("open").describe("Filter by status (defaults to open)"),
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

export const FeedResponse = z.object({
	data: z.array(FeedConversationItem),
	next_cursor: z.string().nullable().describe("Cursor for next page"),
	has_more: z.boolean().describe("Whether more items exist"),
});

// =====================
// Bulk Actions
// =====================

export const BulkActionEnum = z.enum([
	"label",
	"unlabel",
	"archive",
	"unarchive",
	"mark_read",
	"set_priority",
]);

export const BulkActionBody = z.object({
	action: BulkActionEnum.describe("Action to perform"),
	targets: z
		.array(z.string())
		.min(1)
		.max(100)
		.describe("Conversation IDs (max 100)"),
	params: z
		.object({
			labels: z.array(z.string()).optional().describe("Labels for label/unlabel actions"),
			priority: z.string().optional().describe("Priority for set_priority action"),
		})
		.optional()
		.describe("Action-specific parameters"),
});

export const BulkActionResponse = z.object({
	processed: z.number().describe("Number of successfully processed items"),
	failed: z.number().describe("Number of failed items"),
	errors: z.array(z.string()).describe("Error messages for failures"),
});

// =====================
// Search
// =====================

export const SearchQuery = z.object({
	q: z.string().min(1).max(200).describe("Search query"),
	platform: PlatformEnum.optional().describe("Filter by platform"),
	since: z.string().optional().describe("Start date (ISO 8601)"),
	until: z.string().optional().describe("End date (ISO 8601)"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

export const SearchMessageItem = z.object({
	id: z.string().describe("Message ID"),
	conversation_id: z.string().describe("Conversation ID"),
	author_name: z.string().nullable().describe("Author name"),
	author_avatar_url: z.string().nullable().describe("Author avatar URL"),
	text: z.string().nullable().describe("Message text"),
	direction: z.string().describe("Message direction (inbound/outbound)"),
	attachments: z.any().describe("Message attachments"),
	created_at: z.string().describe("Message timestamp"),
});

export const SearchResponse = z.object({
	data: z.array(SearchMessageItem),
	next_cursor: z.string().nullable().describe("Cursor for next page"),
	has_more: z.boolean().describe("Whether more items exist"),
});

// =====================
// Stats
// =====================

export const StatsQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
});

export const PlatformStats = z.object({
	conversations: z.number().describe("Total conversations"),
	unread: z.number().describe("Unread message count"),
});

export const StatsResponse = z.object({
	total_conversations: z.number().describe("Total conversations"),
	open_conversations: z.number().describe("Open conversations"),
	unread_messages: z.number().describe("Unread messages"),
	by_platform: z.record(z.string(), PlatformStats).describe("Stats per platform"),
});

// =====================
// Conversation Detail
// =====================

export const ConversationIdParam = z.object({
	id: z.string().describe("Conversation ID"),
});

export const ConversationDetailMessage = z.object({
	id: z.string().describe("Message ID"),
	conversation_id: z.string().describe("Conversation ID"),
	platform_message_id: z.string().describe("Platform message ID"),
	author_name: z.string().nullable().describe("Author name"),
	author_platform_id: z.string().nullable().describe("Author platform ID"),
	author_avatar_url: z.string().nullable().describe("Author avatar URL"),
	text: z.string().nullable().describe("Message text"),
	direction: z.string().describe("Message direction"),
	attachments: z.any().describe("Attachments"),
	sentiment_score: z.number().nullable().describe("Sentiment score"),
	classification: z.string().nullable().describe("Message classification"),
	platform_data: z.any().describe("Platform-specific data"),
	is_hidden: z.boolean().describe("Whether message is hidden"),
	is_liked: z.boolean().describe("Whether message is liked"),
	created_at: z.string().describe("Message timestamp"),
});

export const ConversationDetailResponse = z.object({
	conversation: FeedConversationItem,
	messages: z.array(ConversationDetailMessage),
});

// =====================
// Conversation Update
// =====================

export const UpdateConversationBody = z.object({
	status: ConversationStatusEnum.optional().describe("New status"),
	labels: z.array(z.string()).optional().describe("Labels to set"),
	priority: z.string().optional().describe("Priority level"),
	assigned_user_id: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe("Assigned organization user ID. Use null to clear the assignee."),
});

export const UpdateConversationResponse = z.object({
	conversation: FeedConversationItem,
});
