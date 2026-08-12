import { z } from "@hono/zod-openapi";

const RelayResourceId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid Relay resource ID");

const ProviderOpaqueId = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(value) =>
			!/[\s/?#\\]/.test(value) &&
			[...value].every((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code > 31 && code !== 127;
			}),
		"Provider IDs cannot contain whitespace, path separators, or controls",
	);

export const RequiredSocialMutationHeaders = z.object({
	"idempotency-key": z.string().min(1).max(255).openapi({
		description:
			"Caller-generated key for one logical provider mutation. Reusing it with a different request is rejected.",
		example: "social-mutation-018f1f6e",
	}),
});

export const PublishedEditParams = z.object({
	post_id: RelayResourceId.describe("Relay post ID"),
});

export const PublishedEditOperationParams = PublishedEditParams.extend({
	operation_id: RelayResourceId.describe("Published-edit operation ID"),
});

export const PublishedEditTargetInput = z.object({
	target_id: RelayResourceId.describe("Relay post target ID"),
	content: z.string().min(1).max(40_000).describe("Replacement text/body"),
	expected_provider_post_id: ProviderOpaqueId.optional().describe(
		"Optional optimistic-concurrency fence for the currently known provider post ID",
	),
});

export const CreatePublishedEditBody = z.object({
	targets: z
		.array(PublishedEditTargetInput)
		.min(1)
		.max(25)
		.refine(
			(targets) =>
				new Set(targets.map((target) => target.target_id)).size ===
				targets.length,
			"target_id values must be unique",
		),
});

export const SocialMutationStatus = z.enum([
	"pending",
	"processing",
	"request_may_have_been_sent",
	"unknown",
	"completed",
	"failed",
]);

export const SocialMutationResponse = z.object({
	id: z.string(),
	target_id: z.string(),
	account_id: z.string(),
	platform: z.string(),
	kind: z.string(),
	status: SocialMutationStatus,
	provider_operation_id: z.string().nullable(),
	provider_post_id: z.string().nullable(),
	result: z.record(z.string(), z.unknown()).nullable(),
	error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	completed_at: z.string().datetime().nullable(),
});

export const PublishedEditBatchResponse = z.object({
	data: z.array(SocialMutationResponse),
	completed: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	unknown: z.number().int().nonnegative(),
	partial: z.boolean(),
});

export const SocialActionParams = z.object({
	conversation_id: RelayResourceId,
	message_id: RelayResourceId,
});

export const EditMessageBody = z.object({
	text: z.string().min(1).max(4096),
});

export const ReadReceiptParams = z.object({
	conversation_id: RelayResourceId,
});

export const ReadReceiptBody = z.object({
	message_id: RelayResourceId.describe("Relay message ID"),
});

export const CommentIdParams = z.object({
	comment_id: ProviderOpaqueId.describe("Provider-native comment or reply ID"),
});

export const EditCommentBody = z.object({
	account_id: RelayResourceId.describe(
		"Exact connected account that owns the comment",
	),
	text: z.string().min(1).max(10_000),
});

export const ModerateCommentBody = z.object({
	account_id: RelayResourceId.describe(
		"Exact connected account used for moderation",
	),
	action: z.enum(["hide", "unhide", "approve", "hold_for_review", "reject"]),
});

export const ProviderPostIdParams = z.object({
	provider_post_id: ProviderOpaqueId.describe("Provider-native post ID"),
});

export const SocialActionOperationParams = z.object({
	operation_id: RelayResourceId.describe(
		"Durable social mutation operation ID",
	),
});

export const SocialActionOperationQuery = z.object({
	account_id: RelayResourceId.describe(
		"Exact connected account for the operation",
	),
});

export const EngagePostBody = z.object({
	account_id: RelayResourceId.describe(
		"Exact connected account performing the action",
	),
	action: z.enum([
		"like",
		"unlike",
		"upvote",
		"downvote",
		"clear_vote",
		"dislike",
		"clear_rating",
	]),
});

export const MentionsQuery = z.object({
	account_id: RelayResourceId.describe("Exact connected account"),
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const MentionResponse = z.object({
	id: z.string(),
	conversation_id: z.string(),
	account_id: z.string(),
	platform: z.string(),
	provider_message_id: z.string(),
	author_name: z.string().nullable(),
	author_platform_id: z.string().nullable(),
	text: z.string().nullable(),
	type: z.enum(["story_mention", "post_mention"]),
	created_at: z.string().datetime(),
});

export const MentionsResponse = z.object({
	data: z.array(MentionResponse),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});
