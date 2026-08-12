import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import {
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { sha256Hex } from "../lib/durable-operation";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { ErrorResponse } from "../schemas/common";
import {
	CommentIdParams,
	EditCommentBody,
	EditMessageBody,
	EngagePostBody,
	type MentionResponse,
	MentionsQuery,
	MentionsResponse,
	ModerateCommentBody,
	ProviderPostIdParams,
	ReadReceiptBody,
	ReadReceiptParams,
	RequiredSocialMutationHeaders,
	SocialActionOperationParams,
	SocialActionOperationQuery,
	SocialActionParams,
	SocialMutationResponse,
} from "../schemas/social-actions";
import {
	getSocialMutation,
	runSocialMutation,
	SocialMutationConflictError,
	serializeSocialMutation,
} from "../services/social-mutation-operations";
import { encryptSocialProjectionPayload } from "../services/social-mutation-projection";
import {
	editConversationMessage,
	editProviderComment,
	engageProviderPost,
	moderateProviderComment,
	type SocialProviderAccount,
	SocialProviderActionError,
	sendReadReceipt,
} from "../services/social-provider-actions";
import { refreshTokenIfNeeded } from "../services/token-refresh-coordinator";
import type { Env, Variables } from "../types";
import { getAccount, resolveInboxTarget } from "./inbox-helpers";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

app.onError((error, c) => {
	if (error instanceof SocialMutationConflictError) {
		markMutationInputNotApplied(c);
		return c.json({ error: { code: error.code, message: error.message } }, 409);
	}
	console.error("[social-actions] request failed", error);
	return c.json(
		{ error: { code: "INTERNAL_ERROR", message: "Social action failed" } },
		500,
	);
});

const mutationResponses = {
	200: {
		description: "Durable social mutation",
		content: { "application/json": { schema: SocialMutationResponse } },
	},
	400: {
		description: "Unsupported or invalid provider mutation",
		content: { "application/json": { schema: ErrorResponse } },
	},
	404: {
		description: "Target not found",
		content: { "application/json": { schema: ErrorResponse } },
	},
	409: {
		description: "Idempotency or active mutation conflict",
		content: { "application/json": { schema: ErrorResponse } },
	},
} as const;

const editMessage = createRoute({
	operationId: "editConversationMessage",
	method: "patch",
	path: "/conversations/{conversation_id}/messages/{message_id}",
	tags: ["Inbox"],
	summary: "Edit a provider message",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: SocialActionParams,
		body: { content: { "application/json": { schema: EditMessageBody } } },
	},
	responses: mutationResponses,
});

const markRead = createRoute({
	operationId: "sendConversationReadReceipt",
	method: "post",
	path: "/conversations/{conversation_id}/read-receipts",
	tags: ["Inbox"],
	summary: "Send a provider read receipt",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: ReadReceiptParams,
		body: { content: { "application/json": { schema: ReadReceiptBody } } },
	},
	responses: mutationResponses,
});

const editComment = createRoute({
	operationId: "editInboxComment",
	method: "patch",
	path: "/comments/{comment_id}",
	tags: ["Inbox"],
	summary: "Edit an owned provider comment",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: CommentIdParams,
		body: { content: { "application/json": { schema: EditCommentBody } } },
	},
	responses: mutationResponses,
});

const moderateComment = createRoute({
	operationId: "moderateInboxComment",
	method: "post",
	path: "/comments/{comment_id}/moderation",
	tags: ["Inbox"],
	summary: "Apply a typed provider moderation action",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: CommentIdParams,
		body: { content: { "application/json": { schema: ModerateCommentBody } } },
	},
	responses: mutationResponses,
});

const engagePost = createRoute({
	operationId: "engageProviderPost",
	method: "put",
	path: "/posts/{provider_post_id}/engagement",
	tags: ["Inbox"],
	summary: "Set a provider-native post reaction, vote, or rating",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredSocialMutationHeaders,
		params: ProviderPostIdParams,
		body: { content: { "application/json": { schema: EngagePostBody } } },
	},
	responses: mutationResponses,
});

const listMentions = createRoute({
	operationId: "listInboxMentions",
	method: "get",
	path: "/mentions",
	tags: ["Inbox"],
	summary: "List normalized mention events for one connected account",
	security: [{ Bearer: [] }],
	request: { query: MentionsQuery },
	responses: {
		200: {
			description: "Mentions",
			content: { "application/json": { schema: MentionsResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Account not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getOperation = createRoute({
	operationId: "getInboxSocialMutationOperation",
	method: "get",
	path: "/operations/{operation_id}",
	tags: ["Inbox"],
	summary: "Get a durable inbox social mutation",
	security: [{ Bearer: [] }],
	request: {
		params: SocialActionOperationParams,
		query: SocialActionOperationQuery,
	},
	responses: {
		200: {
			description: "Durable social mutation",
			content: { "application/json": { schema: SocialMutationResponse } },
		},
		404: {
			description: "Operation or account not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

async function freshProviderAccount(
	c: AppContext,
	accountId: string,
): Promise<SocialProviderAccount | null> {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, organizationId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (
		!account ||
		!canAccessWorkspaceScope(c.get("workspaceScope"), account.workspaceId)
	) {
		return null;
	}
	const accessToken = await refreshTokenIfNeeded(c.env, {
		id: account.id,
		platform: account.platform,
		accessToken: account.accessToken,
		refreshToken: account.refreshToken,
		tokenExpiresAt: account.tokenExpiresAt,
	});
	if (!accessToken) return null;
	return {
		id: account.id,
		platform: account.platform,
		platformAccountId: account.platformAccountId,
		accessToken,
		metadata: account.metadata,
	};
}

function supportsMessageEdit(platform: string): boolean {
	return platform === "telegram" || platform === "discord";
}

function supportsReadReceipt(platform: string): boolean {
	return ["whatsapp", "facebook", "instagram"].includes(platform);
}

function supportsCommentEdit(platform: string): boolean {
	return ["twitter", "facebook", "youtube", "reddit"].includes(platform);
}

function supportsModeration(platform: string, action: string): boolean {
	if (["facebook", "instagram", "twitter"].includes(platform)) {
		return action === "hide" || action === "unhide";
	}
	return (
		platform === "youtube" &&
		["approve", "hold_for_review", "reject"].includes(action)
	);
}

function supportsEngagement(platform: string, action: string): boolean {
	if (platform === "twitter" || platform === "facebook") {
		return action === "like" || action === "unlike";
	}
	if (platform === "reddit") {
		return ["upvote", "downvote", "clear_vote"].includes(action);
	}
	return (
		platform === "youtube" &&
		["like", "dislike", "clear_rating"].includes(action)
	);
}

function unsupportedAction(c: AppContext, code: string, message: string) {
	markMutationInputNotApplied(c);
	return c.json({ error: { code, message } }, 400);
}

app.openapi(editMessage, async (c) => {
	const { conversation_id: conversationId, message_id: messageId } =
		c.req.valid("param");
	const { text } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const target = await resolveInboxTarget(c.get("db"), {
		conversationId,
		messageId,
		organizationId: c.get("orgId"),
		workspaceScope: c.get("workspaceScope"),
	});
	if (target?.message?.direction !== "outbound") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "MESSAGE_NOT_EDITABLE",
					message:
						"Only an outbound message in the authorized conversation can be edited",
				},
			},
			404,
		);
	}
	const message = target.message;
	const messagePlatformData =
		message.platformData &&
		typeof message.platformData === "object" &&
		!Array.isArray(message.platformData)
			? (message.platformData as Record<string, unknown>)
			: {};
	const explicitDiscordThreadId =
		typeof messagePlatformData.discord_thread_id === "string"
			? messagePlatformData.discord_thread_id
			: undefined;
	const discordThreadScoped =
		target.account.platform === "discord" &&
		(target.conversation.type === "comment_thread" ||
			messagePlatformData.discord_thread_scoped === true ||
			explicitDiscordThreadId !== undefined);
	const discordThreadId = discordThreadScoped
		? (explicitDiscordThreadId ?? target.conversation.platformConversationId)
		: undefined;
	if (!supportsMessageEdit(target.account.platform)) {
		return unsupportedAction(
			c,
			"MESSAGE_EDIT_UNSUPPORTED",
			`Message editing is not supported for ${target.account.platform}`,
		) as never;
	}
	const account = await freshProviderAccount(c, target.account.id);
	if (!account) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	const logicalPayload = {
		conversation_id: target.conversation.id,
		message_id: message.id,
		text_hash: await sha256Hex(text),
		expected_edit_revision: message.editRevision,
		discord_thread_context_required: discordThreadScoped,
		discord_thread_id: discordThreadId ?? null,
	};
	const projectionPayloadCiphertext = await encryptSocialProjectionPayload(
		c.env.ENCRYPTION_KEY,
		{
			organizationId: c.get("orgId"),
			targetType: "inbox_message",
			targetId: message.id,
			kind: "message_edit",
		},
		{ text },
	);
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: target.conversation.workspaceId,
		accountId: account.id,
		platform: target.account.platform,
		targetType: "inbox_message",
		targetId: message.id,
		kind: "message_edit",
		operationKey,
		requestPayload: {
			...logicalPayload,
			projection_payload_ciphertext: projectionPayloadCiphertext,
		},
		requestHashPayload: logicalPayload,
		mutationEffectTracker: c.get("mutationEffectTracker"),
		validateBeforeProvider: async () => {
			const current = await resolveInboxTarget(c.get("db"), {
				conversationId,
				messageId,
				organizationId: c.get("orgId"),
				workspaceScope: c.get("workspaceScope"),
			});
			const currentPlatformData =
				current?.message?.platformData &&
				typeof current.message.platformData === "object" &&
				!Array.isArray(current.message.platformData)
					? (current.message.platformData as Record<string, unknown>)
					: {};
			const currentExplicitDiscordThreadId =
				typeof currentPlatformData.discord_thread_id === "string"
					? currentPlatformData.discord_thread_id
					: undefined;
			const currentDiscordThreadScoped =
				current?.account.platform === "discord" &&
				(current.conversation.type === "comment_thread" ||
					currentPlatformData.discord_thread_scoped === true ||
					currentExplicitDiscordThreadId !== undefined);
			const currentDiscordThreadId = currentDiscordThreadScoped
				? (currentExplicitDiscordThreadId ??
					current?.conversation.platformConversationId)
				: undefined;
			if (
				current?.message?.direction !== "outbound" ||
				current.message.id !== message.id ||
				current.message.platformMessageId !== message.platformMessageId ||
				current.message.editRevision !== message.editRevision ||
				current.conversation.id !== target.conversation.id ||
				current.conversation.platformConversationId !==
					target.conversation.platformConversationId ||
				current.account.id !== account.id ||
				current.account.platform !== account.platform ||
				currentDiscordThreadScoped !== discordThreadScoped ||
				currentDiscordThreadId !== discordThreadId
			) {
				throw new SocialProviderActionError(
					"MESSAGE_EDIT_PRECONDITION_CHANGED",
					"Message changed while this edit waited for admission",
					{ definitive: true },
				);
			}
		},
		provider: () =>
			editConversationMessage(
				account,
				target.conversation.platformConversationId,
				message.platformMessageId,
				text,
				{
					discordThreadScoped,
					discordThreadId,
				},
			),
		project: async () => {
			const now = new Date();
			const [updated] = await c
				.get("db")
				.update(inboxMessages)
				.set({
					text,
					editRevision: message.editRevision + 1,
					editedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(inboxMessages.id, message.id),
						eq(inboxMessages.conversationId, target.conversation.id),
						eq(inboxMessages.organizationId, c.get("orgId")),
						eq(inboxMessages.accountId, account.id),
						eq(inboxMessages.platform, message.platform),
						eq(inboxMessages.editRevision, message.editRevision),
					),
				)
				.returning({ id: inboxMessages.id });
			if (!updated) throw new Error("Message projection revision changed");
		},
	});
	return c.json(
		serializeSocialMutation(operation),
		// The operation resource is authoritative even when the provider state is
		// failed/unknown; clients inspect `status` without losing the operation ID.
		200,
	);
});

app.openapi(markRead, async (c) => {
	const { conversation_id: conversationId } = c.req.valid("param");
	const { message_id: messageId } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const target = await resolveInboxTarget(c.get("db"), {
		conversationId,
		messageId,
		organizationId: c.get("orgId"),
		workspaceScope: c.get("workspaceScope"),
	});
	if (target?.message?.direction !== "inbound") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "MESSAGE_NOT_FOUND",
					message: "Inbound message not found",
				},
			},
			404,
		);
	}
	if (!supportsReadReceipt(target.account.platform)) {
		return unsupportedAction(
			c,
			"READ_RECEIPT_UNSUPPORTED",
			`Provider read receipts are not supported for ${target.account.platform}`,
		) as never;
	}
	const account = await freshProviderAccount(c, target.account.id);
	if (!account) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: target.conversation.workspaceId,
		accountId: account.id,
		platform: target.account.platform,
		targetType: "inbox_message",
		targetId: target.message.id,
		kind: "read_receipt",
		operationKey,
		requestPayload: {
			conversation_id: target.conversation.id,
			message_id: target.message.id,
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () =>
			sendReadReceipt(
				account,
				target.conversation.platformConversationId,
				target.message?.platformMessageId ?? "",
			),
		project: async () => {
			const [updated] = await c
				.get("db")
				.update(inboxMessages)
				.set({ providerReadAt: new Date(), updatedAt: new Date() })
				.where(
					and(
						eq(inboxMessages.id, target.message?.id ?? ""),
						eq(inboxMessages.conversationId, target.conversation.id),
						eq(inboxMessages.organizationId, c.get("orgId")),
					),
				)
				.returning({ id: inboxMessages.id });
			if (!updated) throw new Error("Read-receipt projection target changed");
		},
	});
	return c.json(serializeSocialMutation(operation), 200);
});

async function exactCommentAccount(
	c: AppContext,
	accountId: string,
): Promise<SocialProviderAccount | null> {
	// First use the established account/workspace resolver so a request-provided
	// account ID can never escape tenant scope, then refresh from its exact row.
	const scoped = await getAccount(
		c.get("db"),
		accountId,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!scoped) return null;
	return freshProviderAccount(c, scoped.id);
}

app.openapi(editComment, async (c) => {
	const { comment_id: commentId } = c.req.valid("param");
	const { account_id: accountId, text } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const account = await exactCommentAccount(c, accountId);
	if (!account) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	if (!supportsCommentEdit(account.platform)) {
		return unsupportedAction(
			c,
			"COMMENT_EDIT_UNSUPPORTED",
			`Comment editing is not supported for ${account.platform}`,
		) as never;
	}
	const raw = await getAccount(
		c.get("db"),
		account.id,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	const logicalPayload = {
		account_id: account.id,
		comment_id: commentId,
		text_hash: await sha256Hex(text),
	};
	const projectionPayloadCiphertext = await encryptSocialProjectionPayload(
		c.env.ENCRYPTION_KEY,
		{
			organizationId: c.get("orgId"),
			targetType: "comment",
			targetId: commentId,
			kind: "comment_edit",
		},
		{ text },
	);
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: raw?.workspaceId ?? null,
		accountId: account.id,
		platform: raw?.platform ?? "facebook",
		targetType: "comment",
		targetId: commentId,
		kind: "comment_edit",
		operationKey,
		requestPayload: {
			...logicalPayload,
			projection_payload_ciphertext: projectionPayloadCiphertext,
		},
		requestHashPayload: logicalPayload,
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => editProviderComment(account, commentId, text),
		project: async (result) => {
			const now = new Date();
			await c
				.get("db")
				.update(inboxMessages)
				.set({
					text,
					...(result.providerId && result.providerId !== commentId
						? { platformMessageId: result.providerId }
						: {}),
					editRevision: sql`${inboxMessages.editRevision} + 1`,
					editedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(inboxMessages.organizationId, c.get("orgId")),
						eq(inboxMessages.accountId, account.id),
						or(
							eq(inboxMessages.id, commentId),
							eq(inboxMessages.platformMessageId, commentId),
						),
					),
				);
		},
	});
	return c.json(serializeSocialMutation(operation), 200);
});

app.openapi(moderateComment, async (c) => {
	const { comment_id: commentId } = c.req.valid("param");
	const { account_id: accountId, action } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const account = await exactCommentAccount(c, accountId);
	if (!account) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	if (!supportsModeration(account.platform, action)) {
		return unsupportedAction(
			c,
			"MODERATION_ACTION_UNSUPPORTED",
			`${action} is not supported for ${account.platform}`,
		) as never;
	}
	const raw = await getAccount(
		c.get("db"),
		account.id,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: raw?.workspaceId ?? null,
		accountId: account.id,
		platform: raw?.platform ?? "facebook",
		targetType: "comment",
		targetId: commentId,
		kind: "moderation",
		operationKey,
		requestPayload: { account_id: account.id, comment_id: commentId, action },
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => moderateProviderComment(account, commentId, action),
		...(action === "hide" || action === "unhide"
			? {
					project: async () => {
						await c
							.get("db")
							.update(inboxMessages)
							.set({ isHidden: action === "hide", updatedAt: new Date() })
							.where(
								and(
									eq(inboxMessages.organizationId, c.get("orgId")),
									eq(inboxMessages.accountId, account.id),
									or(
										eq(inboxMessages.id, commentId),
										eq(inboxMessages.platformMessageId, commentId),
									),
								),
							);
					},
				}
			: {}),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

app.openapi(engagePost, async (c) => {
	const { provider_post_id: providerPostId } = c.req.valid("param");
	const { account_id: accountId, action } = c.req.valid("json");
	const operationKey = c.req.valid("header")["idempotency-key"];
	const account = await exactCommentAccount(c, accountId);
	if (!account) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	if (!supportsEngagement(account.platform, action)) {
		return unsupportedAction(
			c,
			"ACTION_UNSUPPORTED",
			`${action} is not supported for ${account.platform}`,
		) as never;
	}
	const raw = await getAccount(
		c.get("db"),
		account.id,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	const operation = await runSocialMutation({
		db: c.get("db"),
		organizationId: c.get("orgId"),
		workspaceId: raw?.workspaceId ?? null,
		accountId: account.id,
		platform: raw?.platform ?? "facebook",
		targetType: "provider_post",
		targetId: providerPostId,
		kind: "reaction",
		operationKey,
		requestPayload: {
			account_id: account.id,
			provider_post_id: providerPostId,
			action,
		},
		mutationEffectTracker: c.get("mutationEffectTracker"),
		provider: () => engageProviderPost(account, providerPostId, action),
	});
	return c.json(serializeSocialMutation(operation), 200);
});

app.openapi(listMentions, async (c) => {
	const { account_id: accountId, cursor, limit } = c.req.valid("query");
	const account = await getAccount(
		c.get("db"),
		accountId,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	if (!account) {
		return c.json(
			{
				error: {
					code: "ACCOUNT_NOT_FOUND",
					message: "Connected account is unavailable",
				},
			},
			404,
		);
	}
	const decoded = cursor ? tryDecodeTimestampIdCursor(cursor) : null;
	if (cursor && !decoded) return c.json(INVALID_CURSOR_BODY, 400);
	const conditions = [
		eq(inboxConversations.organizationId, c.get("orgId")),
		eq(inboxConversations.accountId, account.id),
		eq(inboxMessages.accountId, account.id),
		sql`${inboxMessages.platformData}->>'message_type' IN ('story_mention', 'post_mention')`,
	];
	if (decoded) {
		conditions.push(
			or(
				lt(inboxMessages.createdAt, new Date(decoded.timestamp)),
				and(
					eq(inboxMessages.createdAt, new Date(decoded.timestamp)),
					lt(inboxMessages.id, decoded.id),
				),
			) ?? sql`false`,
		);
	}
	const rows = await c
		.get("db")
		.select({ message: inboxMessages, conversation: inboxConversations })
		.from(inboxMessages)
		.innerJoin(
			inboxConversations,
			and(
				eq(inboxMessages.conversationId, inboxConversations.id),
				eq(inboxMessages.organizationId, inboxConversations.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(inboxMessages.createdAt), desc(inboxMessages.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	const data: Array<z.infer<typeof MentionResponse>> = page.map(
		({ message, conversation }) => {
			const messageType = (
				message.platformData as Record<string, unknown> | null
			)?.message_type;
			return {
				id: message.id,
				conversation_id: conversation.id,
				account_id: account.id,
				platform: conversation.platform,
				provider_message_id: message.platformMessageId,
				author_name: message.authorName,
				author_platform_id: message.authorPlatformId,
				text: message.text,
				type:
					messageType === "story_mention" ? "story_mention" : "post_mention",
				created_at: message.createdAt.toISOString(),
			};
		},
	);
	const last = page.at(-1)?.message;
	return c.json(
		{
			data,
			next_cursor:
				hasMore && last
					? encodeTimestampIdCursor(last.createdAt, last.id)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(getOperation, async (c) => {
	const account = await getAccount(
		c.get("db"),
		c.req.valid("query").account_id,
		c.get("orgId"),
		c.env.ENCRYPTION_KEY,
		c.get("workspaceScope"),
	);
	const operation = account
		? await getSocialMutation(
				c.get("db"),
				c.get("orgId"),
				c.req.valid("param").operation_id,
			)
		: null;
	if (
		!account ||
		operation?.accountId !== account.id ||
		!new Set(["inbox_message", "comment", "provider_post"]).has(
			operation.targetType,
		) ||
		!canAccessWorkspaceScope(c.get("workspaceScope"), operation.workspaceId)
	) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social operation not found" } },
			404,
		);
	}
	return c.json(serializeSocialMutation(operation), 200);
});

export default app;
