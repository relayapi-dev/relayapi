import { z } from "@hono/zod-openapi";
import { PlatformEnum, paginatedResponse } from "./common";

// =====================
// Comments
// =====================

export const CommentItem = z.object({
	id: z.string().describe("Comment ID"),
	platform: PlatformEnum,
	author_name: z.string().describe("Comment author name"),
	author_avatar: z.string().nullable().optional().describe("Author avatar URL"),
	text: z.string().describe("Comment text"),
	created_at: z.string().datetime().describe("Comment timestamp"),
	likes: z.number().optional().describe("Like count"),
	replies_count: z.number().optional().describe("Reply count"),
	hidden: z.boolean().optional().describe("Whether comment is hidden"),
	parent_id: z.string().nullable().optional().describe("Parent comment ID if this is a reply"),
	post_id: z.string().optional().describe("Platform post/media/video ID"),
	post_text: z.string().nullable().optional().describe("Post caption snippet"),
	post_thumbnail_url: z.string().nullable().optional().describe("Post thumbnail URL"),
	post_platform_url: z.string().nullable().optional().describe("URL to the post on the platform"),
	account_id: z.string().optional().describe("Social account ID"),
	account_avatar_url: z.string().nullable().optional().describe("Social account avatar URL"),
});

export const CommentsQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items"),
});

export const PostCommentsParams = z.object({
	post_id: z.string().describe("Post ID"),
});

export const CommentIdParams = z.object({
	comment_id: z.string().describe("Comment ID"),
});

export const CommentsResponse = z.object({
	data: z.array(CommentItem),
	post_id: z.string().optional().describe("Post ID if filtered by post"),
	platform: PlatformEnum.optional(),
	next_cursor: z.string().nullable().optional(),
	has_more: z.boolean().optional(),
});

export const ReplyCommentBody = z.object({
	text: z.string().min(1).describe("Reply text"),
	account_id: z.string().describe("Account ID to reply from"),
	comment_id: z
		.string()
		.optional()
		.describe("Parent comment ID for threaded replies"),
});

export const PrivateReplyBody = z.object({
	text: z.string().min(1).describe("Private reply text"),
	account_id: z.string().describe("Account ID to reply from"),
});

export const CommentActionResponse = z.object({
	success: z.boolean().describe("Whether the action succeeded"),
	comment_id: z.string().optional().describe("Comment ID"),
});

export const PostWithComments = z.object({
	id: z.string().describe("Platform post/media/video ID"),
	platform: PlatformEnum,
	account_id: z.string().describe("Social account ID"),
	account_avatar_url: z.string().nullable().optional().describe("Social account avatar URL"),
	text: z.string().nullable().describe("Post caption/message (truncated)"),
	thumbnail_url: z.string().nullable().describe("Post thumbnail URL"),
	platform_url: z.string().nullable().describe("URL to the post on the platform"),
	created_at: z.string().datetime().describe("Post publish timestamp"),
	comments_count: z.number().describe("Total comment count"),
});

export const PostsWithCommentsResponse = z.object({
	data: z.array(PostWithComments),
	next_cursor: z.string().nullable().optional(),
	has_more: z.boolean().optional(),
});

// =====================
// Messages (schemas used by inbox-feed.ts conversation action handlers)
// =====================

export const SendMessageBody = z
	.object({
		text: z.string().min(1).optional().describe("Message text"),
		account_id: z.string().describe("Account ID to send from"),
		attachments: z
			.array(
				z.object({
					url: z.string().url().describe("Attachment URL"),
					type: z.string().describe("Attachment MIME type"),
				}),
			)
			.optional()
			.describe("Attachments"),
		message_tag: z
			.enum(["HUMAN_AGENT", "CUSTOMER_FEEDBACK"])
			.optional()
			.describe(
				"Message tag for sending outside the 24h window (Facebook only)",
			),
		reply_to: z.string().optional().describe("Message ID to reply to"),
		quick_replies: z
			.array(
				z.object({
					content_type: z
						.enum(["text", "user_phone_number", "user_email"])
						.default("text")
						.describe("Quick reply type"),
					title: z
						.string()
						.max(20)
						.optional()
						.describe("Button label (required for text type)"),
					payload: z
						.string()
						.max(1000)
						.optional()
						.describe("Postback payload"),
					image_url: z
						.string()
						.url()
						.optional()
						.describe("Icon URL for the button"),
				}),
			)
			.max(13)
			.optional()
			.describe("Quick reply buttons (Facebook/Instagram, max 13)"),
		template: z
			.object({
				type: z.enum(["generic", "button"]).describe("Template type"),
				elements: z
					.array(
						z.object({
							title: z.string().max(80).describe("Element title"),
							subtitle: z
								.string()
								.max(80)
								.optional()
								.describe("Element subtitle"),
							image_url: z
								.string()
								.url()
								.optional()
								.describe("Element image URL"),
							buttons: z
								.array(
									z.object({
										type: z
											.enum(["web_url", "postback"])
											.describe("Button type"),
										title: z
											.string()
											.max(20)
											.describe("Button label"),
										url: z
											.string()
											.url()
											.optional()
											.describe("URL for web_url buttons"),
										payload: z
											.string()
											.max(1000)
											.optional()
											.describe("Payload for postback buttons"),
									}),
								)
								.max(3)
								.optional()
								.describe("Element buttons (max 3)"),
						}),
					)
					.max(10)
					.describe("Template elements (max 10 for carousel)"),
			})
			.optional()
			.describe("Structured template message (Facebook/Instagram)"),
	})
	.refine(
		(data) =>
			data.text || data.template || (data.attachments && data.attachments.length > 0),
		{
			message: "At least one of text, template, or attachments is required",
		},
	);

export const MessageActionResponse = z.object({
	success: z.boolean().describe("Whether the action succeeded"),
	message_id: z.string().optional().describe("Message ID"),
	error: z.string().optional().describe("Error message if failed"),
});

// =====================
// Typing Indicator
// =====================

export const SendTypingBody = z.object({
	account_id: z.string().describe("Account ID to send from"),
});

// =====================
// Reactions
// =====================

export const AddReactionBody = z.object({
	account_id: z.string().describe("Account ID to react from"),
	emoji: z.string().describe("Unicode emoji character"),
});

export const RemoveReactionQuery = z.object({
	account_id: z.string().describe("Account ID that reacted"),
});

// =====================
// Delete Message
// =====================

export const DeleteMessageQuery = z.object({
	account_id: z.string().describe("Account ID that sent the message"),
});

// =====================
// Reviews
// =====================

export const ReviewItem = z.object({
	id: z.string().describe("Review ID"),
	platform: PlatformEnum,
	author_name: z.string().describe("Review author name"),
	rating: z.number().min(1).max(5).describe("Rating (1-5)"),
	text: z.string().nullable().optional().describe("Review text"),
	reply: z.string().nullable().optional().describe("Business reply text"),
	created_at: z.string().datetime().describe("Review timestamp"),
});

export const ReviewsQuery = z.object({
	platform: PlatformEnum.optional().describe("Filter by platform"),
	account_id: z.string().optional().describe("Filter by account ID"),
	min_rating: z.coerce.number().int().min(1).max(5).optional(),
	max_rating: z.coerce.number().int().min(1).max(5).optional(),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items"),
});

export const ReviewIdParams = z.object({
	review_id: z.string().describe("Review ID"),
});

export const ReviewsListResponse = paginatedResponse(ReviewItem);

export const ReplyReviewBody = z.object({
	text: z.string().min(1).describe("Reply text"),
	account_id: z.string().describe("Account ID"),
});

export const ReviewActionResponse = z.object({
	success: z.boolean().describe("Whether the action succeeded"),
});
