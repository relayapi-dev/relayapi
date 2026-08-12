import { API_VERSIONS, GRAPH_BASE } from "../config/api-versions";
import { isDiscordSnowflake } from "../lib/discord-message-context";
import { parseDiscordWebhookUrl } from "../lib/discord-webhook";
import { readProviderJson, readProviderText } from "../lib/provider-response";
import { igGraphHost } from "../routes/inbox-helpers";

const PROVIDER_TIMEOUT_MS = 15_000;

export type SocialProviderAccount = {
	id: string;
	platform: string;
	platformAccountId: string;
	accessToken: string;
	metadata?: unknown;
};

export class SocialProviderActionError extends Error {
	readonly code: string;
	readonly status: number | null;
	readonly definitive: boolean;

	constructor(
		code: string,
		message: string,
		options: { status?: number; definitive?: boolean } = {},
	) {
		super(message);
		this.name = "SocialProviderActionError";
		this.code = code;
		this.status = options.status ?? null;
		this.definitive = options.definitive ?? false;
	}
}

export type SocialProviderActionResult = {
	providerId?: string;
	providerOperationId?: string;
	providerResult?: Record<string, unknown>;
	/** Provider data needed only by the immediate projection; never persisted. */
	transient?: Record<string, unknown>;
};

function isDefinitiveRejection(status: number): boolean {
	return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

async function providerFailure(
	response: Response,
	code: string,
	message: string,
): Promise<never> {
	// Drain through the bounded reader, but never retain provider diagnostics in
	// the durable operation error. They may echo content or recipient identity.
	await readProviderText(response).catch(() => "");
	throw new SocialProviderActionError(
		code,
		`${message}: HTTP ${response.status}`,
		{
			status: response.status,
			definitive: isDefinitiveRejection(response.status),
		},
	);
}

async function providerFetch(
	url: string | URL,
	init: RequestInit,
	code: string,
	message: string,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});
	} catch {
		throw new SocialProviderActionError(
			"PROVIDER_OUTCOME_UNKNOWN",
			"Provider transport failed after dispatch; outcome is unknown",
		);
	}
	if (!response.ok) await providerFailure(response, code, message);
	return response;
}

function invalidProviderConfirmation(message: string): never {
	throw new SocialProviderActionError("PROVIDER_RESPONSE_INVALID", message);
}

function logicalProviderRejection(code: string, message: string): never {
	throw new SocialProviderActionError(code, message, {
		status: 400,
		definitive: true,
	});
}

async function readRequiredProviderObject(
	response: Response,
	provider: string,
): Promise<Record<string, unknown>> {
	let payload: unknown;
	try {
		payload = await readProviderJson<unknown>(response);
	} catch {
		invalidProviderConfirmation(
			`${provider} did not return a valid JSON confirmation`,
		);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		invalidProviderConfirmation(
			`${provider} did not return the expected confirmation object`,
		);
	}
	return payload as Record<string, unknown>;
}

async function requireBooleanSuccess(
	response: Response,
	options: { provider: string; rejectionCode: string },
): Promise<Record<string, unknown>> {
	const payload = await readRequiredProviderObject(response, options.provider);
	if (payload.success === false) {
		logicalProviderRejection(
			options.rejectionCode,
			`${options.provider} explicitly rejected the mutation`,
		);
	}
	if (payload.success !== true) {
		invalidProviderConfirmation(
			`${options.provider} did not confirm the mutation with success=true`,
		);
	}
	return { acknowledged: true, success: true };
}

async function requireMetaSenderAction(
	response: Response,
	expectedRecipientId: string,
): Promise<Record<string, unknown>> {
	const payload = await readRequiredProviderObject(response, "Meta");
	if (payload.success === false) {
		logicalProviderRejection(
			"META_READ_RECEIPT_REJECTED",
			"Meta explicitly rejected the read receipt",
		);
	}
	if (payload.recipient_id !== expectedRecipientId) {
		invalidProviderConfirmation(
			"Meta did not confirm the read receipt for the expected recipient",
		);
	}
	return { acknowledged: true };
}

async function requireTelegramEditConfirmation(
	response: Response,
	expectedMessageId: number,
): Promise<Record<string, unknown>> {
	const payload = await readRequiredProviderObject(response, "Telegram");
	if (payload.ok === false) {
		logicalProviderRejection(
			"TELEGRAM_EDIT_REJECTED",
			"Telegram explicitly rejected the message edit",
		);
	}
	const result = payload.result;
	if (
		payload.ok !== true ||
		!result ||
		typeof result !== "object" ||
		Array.isArray(result) ||
		(result as Record<string, unknown>).message_id !== expectedMessageId
	) {
		invalidProviderConfirmation(
			"Telegram did not return the edited message with the expected message ID",
		);
	}
	return { acknowledged: true };
}

async function requireProviderResourceId(
	response: Response,
	options: {
		provider: string;
		idField?: string;
		expectedId: string;
	},
): Promise<Record<string, unknown>> {
	const payload = await readRequiredProviderObject(response, options.provider);
	const returnedId = payload[options.idField ?? "id"];
	if (returnedId !== options.expectedId) {
		invalidProviderConfirmation(
			`${options.provider} did not return the expected resource ID`,
		);
	}
	return { acknowledged: true };
}

async function requireXStateConfirmation(
	response: Response,
	options: {
		field: "hidden" | "liked";
		expected: boolean;
		rejectionCode: string;
	},
): Promise<Record<string, unknown>> {
	const payload = await readRequiredProviderObject(response, "X");
	const data = payload.data;
	const state =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)[options.field]
			: undefined;
	if (typeof state !== "boolean") {
		invalidProviderConfirmation(`X did not return the ${options.field} state`);
	}
	if (state !== options.expected) {
		logicalProviderRejection(
			options.rejectionCode,
			`X did not apply the requested ${options.field} state`,
		);
	}
	return { acknowledged: true };
}

async function requireNoContent(
	response: Response,
	provider: string,
): Promise<Record<string, unknown>> {
	if (response.status !== 204) {
		await readProviderText(response).catch(() => "");
		invalidProviderConfirmation(
			`${provider} did not return the documented HTTP 204 confirmation`,
		);
	}
	return { acknowledged: true };
}

async function requireRedditEmptySuccess(
	response: Response,
): Promise<Record<string, unknown>> {
	const body = await readProviderText(response).catch(() => null);
	if (
		body === null ||
		![200, 204].includes(response.status) ||
		body.trim().length > 0
	) {
		invalidProviderConfirmation(
			"Reddit did not return its documented empty success response",
		);
	}
	return { acknowledged: true };
}

function redditForm(values: Record<string, string>): URLSearchParams {
	return new URLSearchParams({ api_type: "json", ...values });
}

async function assertRedditJsonSuccess(response: Response): Promise<void> {
	const payload = await readRequiredProviderObject(response, "Reddit");
	const json = payload.json;
	if (!json || typeof json !== "object" || Array.isArray(json)) {
		invalidProviderConfirmation(
			"Reddit did not return the expected JSON mutation envelope",
		);
	}
	const errors = (json as Record<string, unknown>).errors;
	if (!Array.isArray(errors)) {
		invalidProviderConfirmation(
			"Reddit did not return the mutation error list",
		);
	}
	if (errors.length > 0) {
		throw new SocialProviderActionError(
			"REDDIT_MUTATION_REJECTED",
			"Reddit rejected the mutation",
			{ status: 400, definitive: true },
		);
	}
}

/**
 * Edit provider-published text without pretending media/title edits are
 * supported. X creates a replacement Post and therefore returns a new ID.
 *
 * Official contracts:
 * - https://docs.x.com/x-api/posts/create-or-edit-post
 * - https://developers.facebook.com/docs/graph-api/reference/post/#updating
 * - https://docs.discord.com/developers/resources/webhook#edit-webhook-message
 * - https://www.reddit.com/dev/api/#POST_api_editusertext
 */
export async function editPublishedPost(
	account: SocialProviderAccount,
	providerPostId: string,
	content: string,
	options: {
		discordThreadContextRequired?: boolean;
		discordThreadId?: string;
	} = {},
): Promise<SocialProviderActionResult> {
	switch (account.platform) {
		case "twitter": {
			const response = await providerFetch(
				"https://api.x.com/2/tweets",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						text: content,
						edit_options: { previous_post_id: providerPostId },
					}),
				},
				"X_EDIT_REJECTED",
				"X rejected the Post edit",
			);
			const payload = await readRequiredProviderObject(response, "X");
			const data = payload.data;
			const replacementId =
				data && typeof data === "object" && !Array.isArray(data)
					? (data as Record<string, unknown>).id
					: undefined;
			if (typeof replacementId !== "string" || !replacementId.trim()) {
				throw new SocialProviderActionError(
					"PROVIDER_RESPONSE_INVALID",
					"X acknowledged the edit without returning the replacement Post ID",
				);
			}
			return {
				providerId: replacementId.trim(),
				providerResult: { acknowledged: true },
			};
		}
		case "facebook": {
			const response = await providerFetch(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(providerPostId)}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ message: content }),
				},
				"FACEBOOK_EDIT_REJECTED",
				"Facebook rejected the Page post edit",
			);
			return {
				providerId: providerPostId,
				providerResult: await requireBooleanSuccess(response, {
					provider: "Facebook",
					rejectionCode: "FACEBOOK_EDIT_REJECTED",
				}),
			};
		}
		case "discord": {
			const webhook = parseDiscordWebhookUrl(account.accessToken);
			if (
				options.discordThreadContextRequired &&
				!isDiscordSnowflake(options.discordThreadId)
			) {
				throw new SocialProviderActionError(
					"DISCORD_THREAD_CONTEXT_MISSING",
					"The Discord thread context for this message is unavailable",
					{ status: 409, definitive: true },
				);
			}
			if (
				options.discordThreadId !== undefined &&
				!isDiscordSnowflake(options.discordThreadId)
			) {
				throw new SocialProviderActionError(
					"INVALID_DISCORD_THREAD_ID",
					"Discord thread ID is invalid",
					{ status: 400, definitive: true },
				);
			}
			const editUrl = new URL(
				`${webhook.url}/messages/${encodeURIComponent(providerPostId)}`,
			);
			if (options.discordThreadId) {
				editUrl.searchParams.set("thread_id", options.discordThreadId.trim());
			}
			const response = await providerFetch(
				editUrl,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content,
						allowed_mentions: { parse: [] },
					}),
				},
				"DISCORD_EDIT_REJECTED",
				"Discord rejected the webhook message edit",
			);
			const providerResult = await requireProviderResourceId(response, {
				provider: "Discord",
				expectedId: providerPostId,
			});
			return {
				providerId: providerPostId,
				providerResult,
			};
		}
		case "reddit": {
			const response = await providerFetch(
				"https://oauth.reddit.com/api/editusertext",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/x-www-form-urlencoded",
						"User-Agent": "RelayAPI/1.0",
					},
					body: redditForm({ thing_id: providerPostId, text: content }),
				},
				"REDDIT_EDIT_REJECTED",
				"Reddit rejected the self-text edit",
			);
			await assertRedditJsonSuccess(response);
			return { providerId: providerPostId };
		}
		default:
			throw new SocialProviderActionError(
				"PUBLISHED_EDIT_UNSUPPORTED",
				`Published text editing is not supported for ${account.platform}`,
				{ status: 400, definitive: true },
			);
	}
}

/** Telegram permits bot-authored messages to be edited by chat/message ID. */
export async function editConversationMessage(
	account: SocialProviderAccount,
	platformConversationId: string,
	platformMessageId: string,
	text: string,
	options: { discordThreadScoped?: boolean; discordThreadId?: string } = {},
): Promise<SocialProviderActionResult> {
	if (account.platform === "discord") {
		return editPublishedPost(account, platformMessageId, text, {
			discordThreadContextRequired: options.discordThreadScoped,
			discordThreadId: options.discordThreadId,
		});
	}
	if (account.platform !== "telegram") {
		throw new SocialProviderActionError(
			"MESSAGE_EDIT_UNSUPPORTED",
			`Message editing is not supported for ${account.platform}`,
			{ status: 400, definitive: true },
		);
	}
	const messageId = Number(platformMessageId);
	if (!Number.isSafeInteger(messageId) || messageId <= 0) {
		throw new SocialProviderActionError(
			"INVALID_PROVIDER_MESSAGE_ID",
			"Telegram message ID is invalid",
			{ status: 400, definitive: true },
		);
	}
	const response = await providerFetch(
		`https://api.telegram.org/bot${account.accessToken}/editMessageText`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chat_id: platformConversationId,
				message_id: messageId,
				text,
			}),
		},
		"TELEGRAM_EDIT_REJECTED",
		"Telegram rejected the message edit",
	);
	return {
		providerId: platformMessageId,
		providerResult: await requireTelegramEditConfirmation(response, messageId),
	};
}

/**
 * Send a provider read receipt. WhatsApp receipts bind to an exact provider
 * message ID; Messenger/Instagram's official mark_seen action is conversation
 * scoped and the exact Relay message remains part of the durable target.
 */
export async function sendReadReceipt(
	account: SocialProviderAccount,
	platformConversationId: string,
	platformMessageId: string,
): Promise<SocialProviderActionResult> {
	if (account.platform === "whatsapp") {
		const response = await providerFetch(
			`${GRAPH_BASE.facebook}/${encodeURIComponent(account.platformAccountId)}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					messaging_product: "whatsapp",
					status: "read",
					message_id: platformMessageId,
				}),
			},
			"WHATSAPP_READ_RECEIPT_REJECTED",
			"WhatsApp rejected the read receipt",
		);
		return {
			providerResult: await requireBooleanSuccess(response, {
				provider: "WhatsApp",
				rejectionCode: "WHATSAPP_READ_RECEIPT_REJECTED",
			}),
		};
	}
	if (account.platform === "facebook" || account.platform === "instagram") {
		const host =
			account.platform === "instagram"
				? `https://${igGraphHost(account.accessToken)}`
				: "https://graph.facebook.com";
		const response = await providerFetch(
			`${host}/${API_VERSIONS.meta_graph}/me/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					recipient: { id: platformConversationId },
					sender_action: "mark_seen",
				}),
			},
			"META_READ_RECEIPT_REJECTED",
			"Meta rejected the read receipt",
		);
		return {
			providerResult: await requireMetaSenderAction(
				response,
				platformConversationId,
			),
		};
	}
	throw new SocialProviderActionError(
		"READ_RECEIPT_UNSUPPORTED",
		`Provider read receipts are not supported for ${account.platform}`,
		{ status: 400, definitive: true },
	);
}

export async function editProviderComment(
	account: SocialProviderAccount,
	commentId: string,
	text: string,
): Promise<SocialProviderActionResult> {
	switch (account.platform) {
		case "twitter":
			// X replies are Posts and use the same replacement-ID edit contract.
			return editPublishedPost(account, commentId, text);
		case "facebook": {
			const response = await providerFetch(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(commentId)}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ message: text }),
				},
				"FACEBOOK_COMMENT_EDIT_REJECTED",
				"Facebook rejected the comment edit",
			);
			return {
				providerId: commentId,
				providerResult: await requireBooleanSuccess(response, {
					provider: "Facebook",
					rejectionCode: "FACEBOOK_COMMENT_EDIT_REJECTED",
				}),
			};
		}
		case "youtube": {
			const url = new URL("https://www.googleapis.com/youtube/v3/comments");
			url.searchParams.set("part", "snippet");
			const response = await providerFetch(
				url,
				{
					method: "PUT",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						id: commentId,
						snippet: { textOriginal: text },
					}),
				},
				"YOUTUBE_COMMENT_EDIT_REJECTED",
				"YouTube rejected the comment edit",
			);
			return {
				providerId: commentId,
				providerResult: await requireProviderResourceId(response, {
					provider: "YouTube",
					expectedId: commentId,
				}),
			};
		}
		case "reddit": {
			const response = await providerFetch(
				"https://oauth.reddit.com/api/editusertext",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${account.accessToken}`,
						"Content-Type": "application/x-www-form-urlencoded",
						"User-Agent": "RelayAPI/1.0",
					},
					body: redditForm({ thing_id: commentId, text }),
				},
				"REDDIT_COMMENT_EDIT_REJECTED",
				"Reddit rejected the comment edit",
			);
			await assertRedditJsonSuccess(response);
			return { providerId: commentId };
		}
		default:
			throw new SocialProviderActionError(
				"COMMENT_EDIT_UNSUPPORTED",
				`Comment editing is not supported for ${account.platform}`,
				{ status: 400, definitive: true },
			);
	}
}

export async function moderateProviderComment(
	account: SocialProviderAccount,
	commentId: string,
	action: "hide" | "unhide" | "approve" | "hold_for_review" | "reject",
): Promise<SocialProviderActionResult> {
	if (account.platform === "facebook" || account.platform === "instagram") {
		if (action !== "hide" && action !== "unhide") {
			throw new SocialProviderActionError(
				"MODERATION_ACTION_UNSUPPORTED",
				`${action} is not supported for ${account.platform}`,
				{ status: 400, definitive: true },
			);
		}
		const host =
			account.platform === "instagram"
				? `https://${igGraphHost(account.accessToken)}`
				: "https://graph.facebook.com";
		const body: Record<string, boolean> =
			account.platform === "instagram"
				? { hide: action === "hide" }
				: { is_hidden: action === "hide" };
		const response = await providerFetch(
			`${host}/${API_VERSIONS.meta_graph}/${encodeURIComponent(commentId)}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
			"META_MODERATION_REJECTED",
			"Meta rejected the moderation action",
		);
		return {
			providerId: commentId,
			providerResult: await requireBooleanSuccess(response, {
				provider: account.platform === "instagram" ? "Instagram" : "Facebook",
				rejectionCode: "META_MODERATION_REJECTED",
			}),
		};
	}
	if (account.platform === "twitter") {
		if (action !== "hide" && action !== "unhide") {
			throw new SocialProviderActionError(
				"MODERATION_ACTION_UNSUPPORTED",
				`${action} is not supported for X replies`,
				{ status: 400, definitive: true },
			);
		}
		const response = await providerFetch(
			`https://api.x.com/2/tweets/${encodeURIComponent(commentId)}/hidden`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ hidden: action === "hide" }),
			},
			"X_MODERATION_REJECTED",
			"X rejected the reply visibility change",
		);
		return {
			providerId: commentId,
			providerResult: await requireXStateConfirmation(response, {
				field: "hidden",
				expected: action === "hide",
				rejectionCode: "X_MODERATION_REJECTED",
			}),
		};
	}
	if (account.platform === "youtube") {
		const moderationStatus: string | undefined = (
			{
				approve: "published",
				hold_for_review: "heldForReview",
				reject: "rejected",
			} as Partial<Record<typeof action, string>>
		)[action];
		if (!moderationStatus) {
			throw new SocialProviderActionError(
				"MODERATION_ACTION_UNSUPPORTED",
				`${action} is not supported for YouTube comments`,
				{ status: 400, definitive: true },
			);
		}
		const url = new URL(
			"https://www.googleapis.com/youtube/v3/comments/setModerationStatus",
		);
		url.searchParams.set("id", commentId);
		url.searchParams.set("moderationStatus", moderationStatus);
		const response = await providerFetch(
			url,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
			"YOUTUBE_MODERATION_REJECTED",
			"YouTube rejected the moderation action",
		);
		return {
			providerId: commentId,
			providerResult: await requireNoContent(response, "YouTube"),
		};
	}
	throw new SocialProviderActionError(
		"MODERATION_UNSUPPORTED",
		`Comment moderation is not supported for ${account.platform}`,
		{ status: 400, definitive: true },
	);
}

export async function engageProviderPost(
	account: SocialProviderAccount,
	providerPostId: string,
	action:
		| "like"
		| "unlike"
		| "upvote"
		| "downvote"
		| "clear_vote"
		| "dislike"
		| "clear_rating",
): Promise<SocialProviderActionResult> {
	if (account.platform === "twitter") {
		if (action !== "like" && action !== "unlike") {
			throw new SocialProviderActionError(
				"ACTION_UNSUPPORTED",
				"X supports like or unlike",
				{
					status: 400,
					definitive: true,
				},
			);
		}
		const likesUrl = `https://api.x.com/2/users/${encodeURIComponent(account.platformAccountId)}/likes`;
		const isLike = action === "like";
		const response = await providerFetch(
			isLike ? likesUrl : `${likesUrl}/${encodeURIComponent(providerPostId)}`,
			{
				method: isLike ? "POST" : "DELETE",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					...(isLike ? { "Content-Type": "application/json" } : {}),
				},
				...(isLike
					? { body: JSON.stringify({ tweet_id: providerPostId }) }
					: {}),
			},
			"X_ENGAGEMENT_REJECTED",
			`X rejected the ${action} action`,
		);
		return {
			providerId: providerPostId,
			providerResult: await requireXStateConfirmation(response, {
				field: "liked",
				expected: isLike,
				rejectionCode: "X_ENGAGEMENT_REJECTED",
			}),
		};
	}
	if (account.platform === "facebook") {
		if (action !== "like" && action !== "unlike") {
			throw new SocialProviderActionError(
				"ACTION_UNSUPPORTED",
				"Facebook supports like or unlike",
				{
					status: 400,
					definitive: true,
				},
			);
		}
		const response = await providerFetch(
			`${GRAPH_BASE.facebook}/${encodeURIComponent(providerPostId)}/likes`,
			{
				method: action === "like" ? "POST" : "DELETE",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
			"FACEBOOK_ENGAGEMENT_REJECTED",
			`Facebook rejected the ${action} action`,
		);
		return {
			providerId: providerPostId,
			providerResult: await requireBooleanSuccess(response, {
				provider: "Facebook",
				rejectionCode: "FACEBOOK_ENGAGEMENT_REJECTED",
			}),
		};
	}
	if (account.platform === "reddit") {
		const dir: string | undefined = (
			{
				upvote: "1",
				downvote: "-1",
				clear_vote: "0",
			} as Partial<Record<typeof action, string>>
		)[action];
		if (dir === undefined) {
			throw new SocialProviderActionError(
				"ACTION_UNSUPPORTED",
				"Reddit uses upvote, downvote, or clear_vote",
				{ status: 400, definitive: true },
			);
		}
		const response = await providerFetch(
			"https://oauth.reddit.com/api/vote",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${account.accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "RelayAPI/1.0",
				},
				body: new URLSearchParams({ id: providerPostId, dir }),
			},
			"REDDIT_VOTE_REJECTED",
			"Reddit rejected the vote",
		);
		return {
			providerId: providerPostId,
			providerResult: await requireRedditEmptySuccess(response),
		};
	}
	if (account.platform === "youtube") {
		const rating: string | undefined = (
			{
				like: "like",
				dislike: "dislike",
				clear_rating: "none",
			} as Partial<Record<typeof action, string>>
		)[action];
		if (!rating) {
			throw new SocialProviderActionError(
				"ACTION_UNSUPPORTED",
				"YouTube uses like, dislike, or clear_rating",
				{ status: 400, definitive: true },
			);
		}
		const url = new URL("https://www.googleapis.com/youtube/v3/videos/rate");
		url.searchParams.set("id", providerPostId);
		url.searchParams.set("rating", rating);
		const response = await providerFetch(
			url,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${account.accessToken}` },
			},
			"YOUTUBE_RATING_REJECTED",
			"YouTube rejected the rating",
		);
		return {
			providerId: providerPostId,
			providerResult: await requireNoContent(response, "YouTube"),
		};
	}
	throw new SocialProviderActionError(
		"POST_ENGAGEMENT_UNSUPPORTED",
		`Post engagement is not supported for ${account.platform}`,
		{ status: 400, definitive: true },
	);
}
